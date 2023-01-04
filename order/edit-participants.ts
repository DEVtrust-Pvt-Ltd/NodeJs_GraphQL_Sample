import { ApolloError, ForbiddenError } from "apollo-server";
import { In } from "typeorm";
import { OrderParticipant } from "../../../models/mssql/order-participant";
import { dataLoaders } from "../../resolvers";
import { checkPermissions } from "../../resolvers/query/util";
import { GraphQLContext } from "../../../types/graphql";
import { userPermissions } from "../../../types/auth";
import { EditOrderParticipantsInput } from "../../../types/order";
import { User } from "../../../models/mssql/generic-entity/user";
import { queryRunnerStartTransaction } from "../../..";
import { isUserInAssociatedCompany } from "../../util/user";
import { editPOMessageThread } from "../../util/message";

export const editOrderParticipants = async (
  _: null,

  { input }: { input: EditOrderParticipantsInput },
  context: GraphQLContext
) => {
  const { orderId, participants } = input;
  const { permissions } = context;
  const isIntegration = checkPermissions(permissions, [
    userPermissions.INTEGRATION,
  ]);
  const order = await dataLoaders.orderLoader.load(orderId);

  // get current user info
  const thisUser = await User.findOne(context.userId);

  if (!isUserInAssociatedCompany(order, thisUser) && !isIntegration) {
    throw new ForbiddenError("Unauthorized participant user");
  }

  // verify all participants being added are in fact buyer or supplier users
  //  or consignee,  carrier, broker, forwarder, agent, trucker
  for (const p of participants) {
    const pUser = await User.findOne(p.userId);
    if (!isUserInAssociatedCompany(order, pUser) && !isIntegration) {
      throw new ForbiddenError("Unauthorized participant");
    }
  }

  // remember current list of participants
  const currentParticipants = await OrderParticipant.find({
    orderId,
  });

  const isAdminOrStaff = checkPermissions(permissions, [
    userPermissions.ADMIN,
    userPermissions.STAFF,
  ]);

  // Check if user is allowed to modify these participants
  // if they are admin no need for check, they can do whatever
  if (
    !isAdminOrStaff &&
    !isIntegration &&
    !isAllowedToEditParticipants(currentParticipants, participants, thisUser)
  ) {
    throw new ApolloError("Unauthorized change controller modification");
  }

  // Clear all existing participants
  await OrderParticipant.delete({ orderId });

  if (participants.length < 1) {
    await editPOMessageThread({ orderId }); 
    return []; // this is a participants delete all
  }

  const orderParticipants = participants.map((p) => ({
    ...p,
    orderId,
  }));

  // Add participants
  const qr = await queryRunnerStartTransaction();
  const participantIds = await qr.manager
    .getRepository(OrderParticipant)
    .createQueryBuilder()
    .insert()
    .values(orderParticipants)
    .execute()
    .then((response) => {
      if (!Array.isArray(response.raw) || response.raw.length === 0) {
        throw new ApolloError("Failed to create participants");
      }
      return response.identifiers.map((p: any) => p.id as string);
    });
  await qr.commitTransaction();
  await qr.release(); // Required

  await editPOMessageThread({ orderId });

  return await OrderParticipant.find({
    id: In(participantIds),
  });
};

function isAllowedToEditParticipants(
  currentParticipants: Pick<
    OrderParticipant,
    "userId" | "approvalIsRequired"
  >[],
  participants: Pick<OrderParticipant, "userId" | "approvalIsRequired">[],
  thisUser: User
): boolean {
  // check if user is removing any change control settings or participants of existing change control participants
  let isSelf = 0;
  let countModChangeControllers = 0;
  // check each current participant
  for (const c of currentParticipants) {
    // if they had approval required...
    if (c.approvalIsRequired) {
      // if they are their own user... note that.
      if (c.userId === thisUser.id) {
        isSelf += 1;
        countModChangeControllers += 1;
      } else {
        // otherwise go through list of "new" participant list and see if  any were modified
        //   and if so increase that count
        let foundController = false;
        for (const p of participants) {
          if (p.userId === c.userId) {
            foundController = true;
            if (p.approvalIsRequired !== c.approvalIsRequired) {
              // modifying a non-self user
              countModChangeControllers += 1;
            }
          }
        }
        // case where change controller is removed as participant
        if (!foundController) {
          countModChangeControllers += 1;
        }
      }
    }
  }

  if (!isSelf && countModChangeControllers > 0) {
    // error user should not be allowed to modify change controllers
    return false;
  }

  if (countModChangeControllers > 1) {
    // error user should not be allowed to modify change controllers not themselves
    return false;
  }

  // note case of isSelf and countModChangeContollers==1 is allowed
  // so if makes it here, user is allowed to modify these users
  return true;
}