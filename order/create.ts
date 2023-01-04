import { ForbiddenError, ApolloError } from "apollo-server/dist/exports";
import { In, getManager, QueryRunner } from "typeorm";
import { User } from "../../../models/mssql/generic-entity/user";
import { Order } from "../../../models/mssql/order";
import { OrderParticipant } from "../../../models/mssql/order-participant";
import { OrderParticipantsRights } from "../../../models/mssql/views/order-participants-rights";
import { GraphQLContext } from "../../../types/graphql";
import { CreateOrderInput, isEditOrderKey } from "../../../types/order";
import { dataLoaders } from "../../resolvers";
import { getStatusId } from "../../util/cache";
import { addLineItemsToOrder } from "../../util/order-line-items";
import { createMongoMessagesCreateOrder } from "../../util/messages";
import { createOrderMilestones } from "../../util/milestone";
import {
  genAndUpdatePONumber,
  notifyOrderAssignment,
  notifyOrderOrgsAutoCreation,
  notifyOrderMissingLocation,
  OrderAssignedOrgOptions,
} from "../../util/order";
import { Company } from "../../../models/mssql/generic-entity/company";
import { getPreferences } from "../../util/user";
import { checkPermissions } from "../../resolvers/query/util";
import { userPermissions } from "../../../types/auth";
import { queryRunnerStartTransaction } from "../../..";
import { getFieldConfig } from "../../util";
import { ConfigurationAction } from "../../resolvers/configurations/config-utils";
import { createExtraData } from "../../util/extra-data";
import { createOrGetLocation } from "../../util/location";
import { validateOrderOrg } from "./validate-order-org";
import { createPOMessageThread } from "../../util/message";

type CreateOrderParticipants = {
  buyerOrgId: string;
  supplierOrgId: string;
  otherCompanyIds: string[];
};

export const createOrderParticipants = async (
  { buyerOrgId, supplierOrgId, otherCompanyIds }: CreateOrderParticipants,
  orderId: string,
  queryRunner?: QueryRunner
) => {
  const orderParticipantsRights = !queryRunner
    ? getManager().getRepository(OrderParticipantsRights)
    : queryRunner.manager.getRepository(OrderParticipantsRights);
  const participants = await orderParticipantsRights.find({
    orgId: In([buyerOrgId, supplierOrgId, ...otherCompanyIds].filter(Boolean)),
  });
  const defaultApprovers = new Set(
    [buyerOrgId, supplierOrgId].map((companyId) => {
      // Pick the first participant that has isAllowedToAcceptChangeRequest set
      const participantId = participants.find(
        (p) => p.orgId === companyId && p.isAllowedToAcceptChangeRequest
      )?.participantId;
      if (!participantId) {
        // Temporary fix that marks first entity for buyer + supplier's orgId as able to approve
        // change request.
        participants.sort((a, b) =>
          a.participantId > b.participantId ? 1 : -1
        );
        return participants.find((p) => p.orgId === companyId)?.participantId;
      }
      return participantId;
    })
  );
  if (defaultApprovers.size === 0) {
    throw new ApolloError(`No default participants for order ${orderId}.`);
  }

  const orderParticipantQuery = !queryRunner
    ? OrderParticipant.createQueryBuilder()
    : queryRunner.manager.getRepository(OrderParticipant).createQueryBuilder();
  await orderParticipantQuery
    .insert()
    .values(
      participants.map((p) => {
        return {
          userId: p.participantId,
          // TODO: Comment back in this line when isAllowedToAcceptChangeRequest is populated
          // approvalIsRequired: p.isAllowedToAcceptChangeRequest,
          approvalIsRequired: defaultApprovers.has(p.participantId)
            ? true
            : false,
          orderId,
        };
      })
    )
    .output("INSERTED.*")
    .execute()
    .then((response) => {
      if (!Array.isArray(response.raw) || response.raw.length === 0) {
        throw new ApolloError(`Failed to create order participants.`);
      }
    });
};

export const createOrder = async (
  _: null,
  { input }: { input: CreateOrderInput },
  context: GraphQLContext
) => {
  const {
    extraData,
    shippingInformation,
    lineItems,
    userId,
    participantId,
    shipToLocation,
    ...fields
  } = input;

  const [user, buyer, participant] = await Promise.all([
    User.findOne(userId),
    Company.findOne(fields.buyerId),
    User.findOne(participantId),
  ]);
  let orgId = context.orgId;

  const buyerOrgRole = await dataLoaders.lookupByValueLoader.load(
    "EntityRole,Buyer"
  );
  const currentOrgRoles = await dataLoaders.entityRolesLoader.load(orgId);
  const isBuyerRole = !!currentOrgRoles.find(
    (er) => er.entityRoleId === buyerOrgRole?.id
  );
  const isIntegration = checkPermissions(context.permissions, [
    userPermissions.INTEGRATION,
  ]);
  const buyerPreferences = JSON.parse(buyer?.preferencesString);

  if (isIntegration) {
    orgId = buyer.orgId;
  } else if (
    !user ||
    user.orgId !== orgId ||
    !isBuyerRole ||
    !buyer ||
    (buyerPreferences?.purchaseOrder?.allowExternalCreation === false &&
      buyer.orgId !== orgId)
  ) {
    throw new ForbiddenError(
      `User ${input.userId} does not have permission to create an order for this org.`
    );
  } else if (!participant)
    throw new ForbiddenError(`Invalid participant provided`);

  const preferences = await getPreferences({
    userId,
    orgId,
    buyerOrgId: fields.buyerId,
  });
  const poPrefs = preferences?.purchaseOrder;
  // integration uses fields  but UI uses shippingInformation to store PO number
  let purchaseOrderNumber = fields?.purchaseOrderNumber ?? shippingInformation.purchaseOrderNumber;

  const orderOrgsFields = {
    buyerId: fields.buyerId,
    supplierId: fields.supplierId,
    forwarderId: fields.forwarderId,
    consigneeId: fields.consigneeId,
    agentId: fields.agentId,
    brokerId: fields.brokerId,
    truckerId: fields.truckerId,
  };
  const autoCreatedOrgs = {};

  const isOrgAutoCreateEnabled =
    isIntegration &&
    buyerPreferences?.enableCompanyAutoCreate &&
    !!buyerPreferences?.companyAutoCreateContactList?.length;
  if (isOrgAutoCreateEnabled) {
    const createdOrgs = await validateOrderOrg({
      fields,
      purchaseOrderNumber,
      permissions: context.permissions,
      userId: context.userId,
      buyer,
    });
    Object.assign(autoCreatedOrgs, createdOrgs);
    Object.assign(orderOrgsFields, createdOrgs);
  }

  // Validate whether fields are editable
  Object.keys({ ...shippingInformation, ...fields }).map((key) => {
    if (isEditOrderKey(key)) {
      if (
        !getFieldConfig(poPrefs[key], ConfigurationAction.CREATE)?.editable &&
        !isIntegration
      ) {
        throw new ForbiddenError(
          `User does not have permission to create field ${key}`
        );
      }
    }
  });

  // Use default T&C if none provided.
  const termsAndConditions =
    shippingInformation.termsAndConditions || preferences?.termsAndConditions;

  // Handle unknown Locations coming in via integration:
  if (
    !shippingInformation?.destinationId &&
    isIntegration &&
    preferences?.enableLocationAutoCreate
  ) {
    if (shipToLocation) {
      shipToLocation.orgId = buyer.orgId;
      const locationType = await dataLoaders.lookupByValueLoader.load(
        "LocationType,Destination"
      );
      const newLocation = await createOrGetLocation(
        locationType,
        shipToLocation,
        context
      );
      shippingInformation.destinationId = newLocation.id;
    }
  }

  const issuedStatusId = await getStatusId("Issued", "OrderStatus");
  const qr = await queryRunnerStartTransaction();
  let orderId;
  try {
    const createdOn = new Date();
    orderId = await qr.manager
      .getRepository(Order)
      .createQueryBuilder()
      .insert()
      .values([
        {
          _transNumber: "", // See comment in model
          orgId,
          ...orderOrgsFields,
          ...shippingInformation,
          termsAndConditions,
          orderStatusId: issuedStatusId,
          isReadyForBooking: false,
          createdOn,
          lastUpdatedDate: createdOn,
          purchaseOrderNumber,
        },
      ])
      .output("INSERTED.*")
      .execute()
      .then((response) => {
        if (!Array.isArray(response.raw) || response.raw.length === 0) {
          throw new ApolloError(`Failed to create order`);
        }

        return response.identifiers[0].id as string;
      });
    await createOrderParticipants(
      {
        buyerOrgId: orgId,
        supplierOrgId: fields.supplierId,
        otherCompanyIds: [fields.consigneeId, fields.forwarderId],
      },
      orderId,
      qr
    );

    if (extraData?.length) {
      await createExtraData(extraData, orgId, orderId, "Order", qr);
    }

    await createOrderMilestones(orderId, orgId, qr); // ToDo

    await qr.commitTransaction();
    await qr.release(); // Required
  } catch (error) {
    if (qr.isTransactionActive) {
      await qr.rollbackTransaction();
    }
    await qr.release();
    throw new ApolloError(`createOrder ${error}`);
  }

  // Essentially this is a after insert trigger. Doing a write, read, write actually prevents race
  // conditions because the data stored in the DB is the source of truth.
  if (!purchaseOrderNumber) {
    purchaseOrderNumber = await genAndUpdatePONumber(orgId, orderId);
  }

  // Adding line items takes too long to include in transaction.
  if (lineItems) {
    await addLineItemsToOrder(lineItems, orderId, fields.supplierId, orgId);
  }
  await createMongoMessagesCreateOrder(
    orderId,
    purchaseOrderNumber,
    { sender: user, rest: [participant] },
    context.mongoManager
  );

  const createdOrder = await dataLoaders.orderLoader.load(orderId);

  // Notify the buyer if this order is missing a destinationId:
  if (
    !shippingInformation?.destinationId &&
    isIntegration &&
    preferences?.enableLocationAutoCreate
  ) {
    await notifyOrderMissingLocation(
      createdOrder,
      preferences?.locationAutoCreateContactList
    );
  }

  if (isOrgAutoCreateEnabled) {
    await notifyOrderOrgsAutoCreation({
      users: buyerPreferences?.companyAutoCreateContactList,
      order: createdOrder,
      createdOrgs: autoCreatedOrgs,
    });
  }

  let agent = null;
  let broker = null;
  let trucker = null;

  // Notify agent/broker of assignment to order:
  if (createdOrder?.agentId) {
    agent = await dataLoaders.entityLoader.load(createdOrder?.agentId);
  }
  if (createdOrder?.brokerId) {
    broker = await dataLoaders.entityLoader.load(createdOrder?.brokerId);
  }
  if (createdOrder?.truckerId) {
    trucker = await dataLoaders.entityLoader.load(createdOrder?.truckerId);
  }

  // It's possible that we have no agent or broker (agent and/or broker is null)
  //  In this case, we will still call notifyOrderAssignment, but it will bail for missing users.
  const agentBrokers = [
    { org: agent, orgRole: "Agent" },
    { org: broker, orgRole: "Broker" },
    { org: trucker, orgRole: "Trucker" },
  ] as OrderAssignedOrgOptions[];
  await notifyOrderAssignment(createdOrder, agentBrokers);

  await createPOMessageThread({
    userId,
    orderId,
  });

  return createdOrder;
};
