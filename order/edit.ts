import { ApolloError, ForbiddenError } from "apollo-server/dist/exports";
import { isEmpty, has as lodashHas, find } from "lodash";
import moment from "moment";
import {
  getManager,
  Brackets,
  InsertResult,
  MongoEntityManager,
  UpdateResult,
} from "typeorm";
import { User } from "../../../models/mssql/generic-entity/user";
import { OrderLineItem } from "../../../models/mssql/order-line-item";
import { Order } from "../../../models/mssql/order";
import { OrderChangeRequest } from "../../../models/mssql/order-change-request";
import { OrderChangeRequestLineItem } from "../../../models/mssql/order-change-request-line-item";
import { OrderChangeReview } from "../../../models/mssql/order-change-review";
import { OrderParticipant } from "../../../models/mssql/order-participant";
import { CombinedResponse, GraphQLContext } from "../../../types/graphql";
import {
  EditOrderLineItemInput,
  EditOrderInput,
  EditOrderStatusInput,
  isEditOrderKey,
  OrderLineItemsInput,
  OrderShippingInformationInput,
} from "../../../types/order";
import { ExtraDataInput } from "../../../types/extra-data";
import { userPermissions } from "../../../types/auth";
import { dataLoaders } from "../../resolvers";
import { checkReadyForBookingResolver } from "../../resolvers/query/check-ready-for-booking";
import { ConfigurationAction } from "../../resolvers/configurations/config-utils";
import { checkPermissions } from "../../resolvers/query/util";
import { getFieldConfig, isVisible } from "../../util";
import { getChangeStatusId, getStatusId } from "../../util/cache";
import {
  generateChangeRequestDescription,
  generateOrderChangeRequestLineItems,
} from "../../util/change-request";
import { getFulfillmentsForOrder } from "../../util/fulfillment";
import {
  addLineItemsToOrder,
  editLineItemsInOrder,
  removeLineItemsFromOrder,
  replaceLineItemsInOrder,
} from "../../util/order-line-items";
import { createMongoMessagesEditOrder } from "../../util/messages";
import {
  completeMilestone,
  getOrderMilestoneByName,
} from "../../util/milestone";
import {
  isOrderEditable,
  notifyOrderMissingLocation,
  orderReadyForBookingErrors,
  resetOrder,
  updateOrder,
} from "../../util/order";
import { getPreferences } from "../../util/user";
import { Company } from "../../../models/mssql/generic-entity/company";
import { createOrGetLocation } from "../../util/location";
import { editPOMessageThread } from "../../util/message";

import { BookingRequest } from "../../../models/mssql/booking-request";
import { FulfillmentRollup } from "../../../models/mssql/views/fulfillment-rollup";
import { BookingConfirmation } from "../../../models/postgres/booking-confirmation";
import { Shipment } from "../../../models/postgres/shipment";
import { LineItem } from "../../../models/postgres/line-item";

const handleErrors = (responses: CombinedResponse[]) => {
  const isNote = (response: CombinedResponse) => "Note" in response.raw.columns;
  const isLineItem = (response: CombinedResponse) =>
    "OrderOid" in response.raw.columns;
  const shouldClearLineItem = (response: CombinedResponse) =>
    "OrderOid" in response.raw[0] && "Oid" in response.raw[0];
  const errorObjectType = (response: CombinedResponse) => {
    let errorEntity = "object";
    if (isNote(response)) errorEntity = "note";
    if (isLineItem(response)) errorEntity = "line item";
    return errorEntity;
  };

  // Map over responses to either throw useful errors or clear the cache of modified line items
  // when appropriate.
  if (Array.isArray(responses)) {
    responses.map((response) => {
      if (response instanceof InsertResult) {
        if (!Array.isArray(response.raw) || response.raw.length === 0) {
          throw new ForbiddenError(
            `Failed to create ${errorObjectType(
              response
            )} and relate it to order.`
          );
        }
      }
      if (response instanceof UpdateResult) {
        if (!Array.isArray(response.raw) || response.raw.length === 0) {
          throw new ForbiddenError(
            `Failed to update ${errorObjectType(response)}.`
          );
        }
        if (shouldClearLineItem(response)) {
          dataLoaders.orderLineItemLoader.clear(response.raw[0].Oid);
        }
      }
    });
  }
};

export const editOrderStatus = async (
  _: null,
  { input }: { input: EditOrderStatusInput },
  { orgId }: GraphQLContext
): Promise<Order> => {
  const { orderId, orderStatusId } = input;

  // If an order is being canceled or rejected we need to reset the order to a like-new state.
  const [
    order,
    canceledStatusId,
    rejectedStatusId,
    acceptedStatusId,
  ] = await Promise.all([
    // Clear the cache of this order to prevent race conditions.
    dataLoaders.orderLoader.clear(orderId).load(orderId),
    getStatusId("Canceled", "OrderStatus"),
    getStatusId("Rejected", "OrderStatus"),
    getStatusId("Accepted", "OrderStatus"),
  ]);

  if (orderStatusId === canceledStatusId) {
    const availableToCancel = await canOrderBeCancelled(orderId);
    if (!availableToCancel) {
      throw new ForbiddenError(
        `Cannot cancel a Purchase Order that has a booked request, booked confirmation or shipment.`
      );
    }
  }

  if (
    orderStatusId === canceledStatusId ||
    orderStatusId === rejectedStatusId
  ) {
    await resetOrder(order);
  }

  const updateBookingReady = {} as Order;
  if (
    orderStatusId === acceptedStatusId &&
    order.orderStatusId !== acceptedStatusId
  ) {
    // If an order is not ready for booking it cannot be accepted.
    const readyForBookingErrors = await orderReadyForBookingErrors(order);
    if (!isEmpty(readyForBookingErrors)) {
      throw new ForbiddenError(readyForBookingErrors.join(", "));
    }

    const acceptedMilestone = await getOrderMilestoneByName(
      "PO Accepted",
      order
    );
    if (acceptedMilestone) {
      await completeMilestone(acceptedMilestone);
    }

    const bookingReadyMilestone = await getOrderMilestoneByName(
      "Ready for Booking",
      order
    );
    // If a ready for booking milestone exists then complete it.
    if (bookingReadyMilestone) {
      await completeMilestone(bookingReadyMilestone);
    }
    updateBookingReady.isReadyForBooking = true;
  }

  await updateOrder(orderId, orgId, {
    orderStatusId,
    ...updateBookingReady,
  });
  return await dataLoaders.orderLoader.clear(orderId).load(orderId);
};

export const editOrder = async (
  _: null,
  { input }: { input: EditOrderInput },
  context: GraphQLContext
): Promise<Order> => {
  let updatedOrder;
  // Parse context for use but leave access to object for calling other resolvers.
  let { orgId } = context;
  const { userId, ...inputSubUser } = input;
  const {
    orderId,
    shipToLocation,
    shippingInformation = {},
    ...inputSubShip
  } = inputSubUser;
  // Clear the cache of this order to prevent race conditions.
  let order = await dataLoaders.orderLoader.clear(orderId).load(orderId);
  const buyer = await Company.findOne(order.buyerId);
  const buyerPreferences = JSON.parse(buyer?.preferencesString);

  const [user, fulfillments, receivedStatusId, acceptedStatusId] = await Promise.all([
    User.findOne(userId),
    getFulfillmentsForOrder(orderId, context.sqlManager),
    getStatusId("Received", "OrderStatus"),
    getStatusId("Accepted", "OrderStatus"),
  ]);
  // Check user assosiated company
  if (!isVisible(context)(order)) {
    throw new ForbiddenError(
      "User does not have permission to edit this order."
    );
  }

  const { isEditable, message } = await isOrderEditable(
    order,
    user,
    context,
    fulfillments
  );
  if (!isEditable) {
    throw new ForbiddenError(message);
  }

  const isIntegration = checkPermissions(context.permissions, [
    userPermissions.INTEGRATION,
  ]);

  // Handle unknown Locations coming in via integration:
  if (
    !shippingInformation?.destinationId &&
    isIntegration &&
    buyerPreferences?.enableLocationAutoCreate
  ) {
    if (shipToLocation) {
      shipToLocation.orgId = order.buyerId;
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

  if (isIntegration) {
    orgId = buyer.orgId;
    // Integration resets the order and never invokes change control.
    updatedOrder = await editAndResetOrder(
      user,
      order,
      shippingInformation,
      inputSubShip,
      { ...context, orgId: order.buyerId }
    );

    // Notify the buyer if this order is missing a destinationId:
    if (
      !shippingInformation?.destinationId &&
      isIntegration &&
      buyerPreferences?.enableLocationAutoCreate
    ) {
      await notifyOrderMissingLocation(
        updatedOrder,
        buyerPreferences?.locationAutoCreateContactList
      );
    }
    return updatedOrder;
  }

  const editFields = {
    ...shippingInformation,
    ...inputSubShip,
  };
  const poPrefs = await checkFieldsEditable({
    userId,
    orgId,
    buyerOrgId: order.buyerId,
    editFields,
  });

  const {
    lineItems = {} as OrderLineItemsInput,
    orderStatusId,
    ...inputRest
  } = inputSubShip;
  await checkLineItems(orderId, lineItems);

  // Editing order status needs to do additional housekeeping.
  if (orderStatusId && orderStatusId !== order.orderStatusId) {
    order = await editOrderStatus(
      null,
      { input: { orderId, orderStatusId } },
      context
    );
  }

  // ToDo: Use preferences to determine which fields get change control.
  const excludedFromChangeCtl = poPrefs?.excludeChangeControl || [
    "cargoReadyDate",
    "hotFlag",
    "specialInstructions",
  ];
  const shippingInfoChangeReq = {} as any;
  const shippingNoChangeCtl = {} as any;
  const { extraData, ...shippingInfoSubExtra } = shippingInformation;
  Object.keys(shippingInfoSubExtra).map(
    (skey: keyof OrderShippingInformationInput) => {
      if (excludedFromChangeCtl.includes(skey)) {
        // shippingInformation field(s) that never have change control
        shippingNoChangeCtl[skey] = (shippingInfoSubExtra as any)[skey];
      } else {
        shippingInfoChangeReq[skey] = (shippingInfoSubExtra as any)[skey];
      }
    }
  );

  const hasChangeControl =
    poPrefs?.enableChangeControl === true &&
    (order.orderStatusId === receivedStatusId || order.orderStatusId === acceptedStatusId) &&
    (!isEmpty(shippingInfoChangeReq) || !isEmpty(lineItems));
  const hasOnlyChangeControl = hasChangeControl && isEmpty(shippingNoChangeCtl);

  // This is the fork in the road where we decide whether to actually change the db or propose
  // edits as order change requests.
  // Path A: No change control:
  //                   !Accepted or !Received status, or only cargoReadyDate in shippingInformation.
  // Path B: Only change control:
  //                    Received or Accepted status, shippingInformation without cargoReadyDate
  // Path C: Both A & B:
  //                    Received or Accepted status, shippingInformation fields plus cargoReadyDate.

  if (!hasChangeControl) {
    // Path A: no change control.
    await updateOrder(
      orderId,
      orgId,
      {
        ...inputRest,
        ...shippingInfoSubExtra,
      },
      extraData
    );
    const _order = await dataLoaders.orderLoader.clear(orderId).load(orderId);
    await updateLineItems({ order: _order, user, lineItems });
  } else {
    // Path B & C
    await invokeChangeControl({
      order,
      user,
      orgId,
      lineItems,
      shippingInformation: shippingInfoSubExtra,
      orderChangeRequestNote: input.orderChangeRequestNote,
      mongoManager: context.mongoManager,
      extraData,
    });
    // Path C
    if (!hasOnlyChangeControl) {
      await updateOrder(
        orderId,
        orgId,
        {
          ...inputRest,
          ...shippingNoChangeCtl,
        },
        extraData
      );
    }
  }

  // Now that we've made a bunch of changes to the order, let's do some housekeeping to see if the
  // order's ready for booking status has changed. If it has, the function updates the DB.
  await checkReadyForBookingResolver({}, { orderId: order.id }, context);
  updatedOrder = await dataLoaders.orderLoader.clear(orderId).load(orderId);

  const associatedCompanyIdKeys = [
    "agentId",
    "brokerId",
    "consigneeId",
    "forwarderId",
    "supplierId",
    "truckerId",
  ];

  const participantUpdated = associatedCompanyIdKeys.find(
    (associatedCompanyIdKey) => {
      return lodashHas(editFields, associatedCompanyIdKey);
    }
  );
  if (participantUpdated) {
    await editPOMessageThread({ orderId });
  }

  return updatedOrder;
};

interface InvokeChangeControlInterface {
  order: Order;
  user: User;
  orgId: string;
  lineItems: OrderLineItemsInput;
  shippingInformation: OrderShippingInformationInput;
  orderChangeRequestNote: string;
  mongoManager: MongoEntityManager;
  extraData: ExtraDataInput[];
}

async function invokeChangeControl(input: InvokeChangeControlInterface) {
  const {
    order,
    user,
    orgId,
    lineItems,
    shippingInformation,
    mongoManager,
    extraData,
  } = input;

  // 1) Update the order status to IsReadyForBooking = 0
  await updateOrder(order.id, orgId, { isReadyForBooking: false }, extraData);

  // 2) Insert into [OrderChangeRequest]
  const {
    addLineItems,
    editLineItems,
    removeLineItems,
    replaceLineItems,
  } = lineItems;
  const lastChangeRequest = await OrderChangeRequest.createQueryBuilder()
    .where({ orderId: order.id })
    // Since OrderChangeRequest has a date rather than a timestamp for CreatedOn we use the
    // fact that the keys increment to determine the next change request number.
    .orderBy("Oid", "DESC")
    .getOne();
  const changeRequestNumber = lastChangeRequest
    ? +lastChangeRequest.changeRequestNumber + 1
    : 1;
  const proposedChangeStatusId = await getChangeStatusId("Proposed");
  const orderChangeRequestId = await OrderChangeRequest.createQueryBuilder()
    .insert()
    .values({
      orderId: order.id,
      entityId: user.id,
      changeStatusId: proposedChangeStatusId,
      title: `Change Request #${changeRequestNumber}`,
      description: await generateChangeRequestDescription(
        addLineItems,
        editLineItems,
        removeLineItems,
        replaceLineItems,
        shippingInformation,
        order
      ),
      createdOn: new Date(moment(new Date()).format("YYYY-MM-DD")),
      note: input.orderChangeRequestNote,
      changeRequestNumber,
    })
    .output("INSERTED.*")
    .execute()
    .then((response) => {
      if (!Array.isArray(response.raw) || response.raw.length === 0) {
        throw new ForbiddenError(`Failed to create order change request`);
      }
      return response.identifiers[0].id as string;
    });

  const [changeRequest, orderParticipants] = await Promise.all([
    OrderChangeRequest.findOne(orderChangeRequestId),
    User.createQueryBuilder("user")
      .leftJoin(OrderParticipant, "participant", "participant.userId = user.id")
      .where("participant.orderId = :orderId", { orderId: order.id })
      .getMany(),
  ]);
  const rest = orderParticipants.filter((p) => p.id !== user.id);
  await createMongoMessagesEditOrder(
    changeRequest,
    { sender: user, rest },
    orgId,
    mongoManager
  );

  // 3) Insert into [OrderChangeReview]
  const approvedChangeStatusId = await getChangeStatusId("Approved");
  const approvers = await OrderParticipant.find({
    orderId: order.id,
    approvalIsRequired: true,
  });
  await OrderChangeReview.createQueryBuilder()
    .insert()
    .values(
      approvers.map((p) => {
        return {
          orderChangeRequestId,
          entityId: p.userId,
          reviewDate: p.userId === user.id ? new Date() : null,
          changeStatusId:
            p.userId === user.id
              ? approvedChangeStatusId
              : proposedChangeStatusId,
        };
      })
    )
    .execute();

  // 4) Insert into [OrderChangeRequestLineItem]
  await OrderChangeRequestLineItem.createQueryBuilder()
    .insert()
    .values(
      await generateOrderChangeRequestLineItems(
        addLineItems,
        editLineItems,
        removeLineItems,
        replaceLineItems,
        shippingInformation,
        order,
        orderChangeRequestId
      )
    )
    .execute();
}

async function updateLineItems(input: {
  order: Order;
  user: User;
  lineItems: OrderLineItemsInput;
}) {
  const { user, order } = input;
  const {
    addLineItems,
    editLineItems,
    removeLineItems,
    replaceLineItems,
  } = input.lineItems;
  const queries: Promise<any>[] = [];
  if (replaceLineItems) {
    // Replace and/or add line items
    queries.push(
      replaceLineItemsInOrder(
        replaceLineItems,
        order.id,
        order.supplierId,
        user.orgId
      )
    );
  } else {
    if (addLineItems) {
      queries.push(
        addLineItemsToOrder(
          addLineItems,
          order.id,
          order.supplierId,
          user.orgId
        )
      );
    }
    if (editLineItems) {
      queries.push(editLineItemsInOrder(editLineItems, order.id, user.orgId));
    }
    if (removeLineItems) {
      queries.push(removeLineItemsFromOrder(removeLineItems, order.id));
    }
  }

  await Promise.all(queries).then((responses) => handleErrors(responses));
}

// Check preferences config to ensure the account has permission to edit the supplied fields.
async function checkFieldsEditable({
  userId,
  orgId,
  buyerOrgId,
  editFields,
}: {
  userId: string;
  orgId: string;
  buyerOrgId: string;
  editFields: any;
}) {
  const preferences = await getPreferences({ userId, orgId, buyerOrgId });
  const poPrefs = preferences?.purchaseOrder;
  const editParams: Record<string, any> = editFields;
  Object.keys(editParams).map((key) => {
    // Client may send an empty key object (e.g. lineItems) if no values are provided
    // for said key. Skip permission checking in such cases.
    if (!isEmpty(editParams[key]) && isEditOrderKey(key)) {
      if (
        !getFieldConfig(poPrefs?.headerFields?.[key], ConfigurationAction.EDIT)
          ?.editable
      ) {
        throw new ForbiddenError(
          `User does not have permission to edit field ${key}`
        );
      }
    }
  });
  return poPrefs;
}

async function checkLineItems(orderId: string, lineItems: any) {
  const {
    addLineItems,
    editLineItems,
    removeLineItems,
    replaceLineItems,
  } = lineItems;
  if (replaceLineItems && (addLineItems || editLineItems || removeLineItems)) {
    throw new ForbiddenError(
      `You cannot replace and add/edit/remove line items.`
    );
  }
  if (editLineItems && removeLineItems) {
    editLineItems.map((editItem: EditOrderLineItemInput) => {
      if (removeLineItems.includes(editItem.lineItemId)) {
        throw new ForbiddenError(
          `You cannot edit and remove the same line item.`
        );
      }
    });
  }

  const lineItemIds = (await OrderLineItem.find({ orderId })).map(
    (line) => line.id
  );
  lineItemIds.map((id) => dataLoaders.orderLineItemLoader.clear(id));
}

// Edit order and reset it, without change control. Used by integration.
async function editAndResetOrder(
  user: User,
  order: Order,
  shippingInformation: any,
  inputSubShip: any,
  context: GraphQLContext
): Promise<Order> {
  const { orgId } = context;
  let _order = order;
  const { lineItems = {} as OrderLineItemsInput, ...inputRest } = inputSubShip;
  await checkLineItems(order.id, lineItems);

  const orderStatusId = inputRest?.orderStatusId;
  if (orderStatusId && orderStatusId !== order.orderStatusId) {
    _order = await editOrderStatus(
      null,
      { input: { orderId: order.id, orderStatusId } },
      context
    );
  }

  const { extraData, ...shippingInfoSubExtra } = shippingInformation;
  await resetOrder(_order);
  await updateOrder(
    _order.id,
    orgId,
    {
      ...inputRest,
      ...shippingInfoSubExtra,
    },
    extraData
  );
  _order = await dataLoaders.orderLoader.clear(order.id).load(order.id);
  await updateLineItems({ order: _order, user, lineItems });

  // Now that we've made a bunch of changes to the order, let's do some housekeeping to see if the
  // order's ready for booking status has changed. If it has, the function updates the DB.
  await checkReadyForBookingResolver({}, { orderId: order.id }, context);
  return await dataLoaders.orderLoader.clear(order.id).load(order.id);
}

async function canOrderBeCancelled(orderId: string): Promise<boolean> {
  //br
  const bookingRequestIds = (
    await getManager().find(FulfillmentRollup, {
      select: ["bookingRequestId"],
      where: { orderId },
    })
  ).map((f) => f.bookingRequestId);

  let bookingRequests = await dataLoaders.bookingRequestLoader.loadMany(
    bookingRequestIds
  );

  const bookingCancelStatus = await dataLoaders.lookupByValueLoader.load(
    "BookingStatus,Canceled"
  );

  const bookingCancelStatusId = bookingCancelStatus.id;

  const activeBR = bookingRequests.find((br: BookingRequest) => {
    return br.bookingStatusId !== bookingCancelStatusId;
  });

  if (activeBR) {
    return false;
  }

  //bc
  const bookingConfirmations = await getManager("postgres")
    .getRepository(BookingConfirmation)
    .createQueryBuilder("bc")
    .innerJoin(LineItem, "li", "li.target_id=bc.id")
    .where("li.fields->>'orderId' = :orderId", { orderId })
    .andWhere(
      new Brackets((qb) => {
        qb.where("bc.fields->>'statusId' != :statusId", {
          statusId: bookingCancelStatusId,
        }).orWhere("bc.fields->>'statusId' is NULL");
      })
    )
    .andWhere("bc.created_at!=bc.updated_at")
    .andWhere("li.deleted_at is NULL")
    .getMany();

  if (!isEmpty(bookingConfirmations)) {
    return false;
  }

  //shipment
  const shipmentCanceledStatusId = await dataLoaders.lookupByValueLoader.load(
    "ShipmentStatus,Canceled"
  );
  const shipments = await getManager("postgres")
    .getRepository(Shipment)
    .createQueryBuilder("shipment")
    .innerJoin(LineItem, "li", "li.target_id=shipment.id")
    .where("li.fields->>'orderId' = :orderId", { orderId })
    .andWhere(
      new Brackets((qb) => {
        qb.where("li.fields->>'shipmentStatusId' != :statusId", {
          statusId: shipmentCanceledStatusId?.id,
        }).orWhere("li.fields->>'shipmentStatusId' is NULL");
      })
    )
    .andWhere("shipment.created_at!=shipment.updated_at")
    .andWhere("li.deleted_at is NULL")
    .getMany();
  if (!isEmpty(shipments)) {
    return false;
  }

  return true;
}
