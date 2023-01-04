import { min } from "lodash";
import moment from "moment";
import { getManager } from "typeorm";
import { dataLoaders } from "..";
import { BookingConfirmation } from "../../../models/postgres/booking-confirmation";
import { GetByArgs } from "../../../types/common";
import { GraphQLContext } from "../../../types/graphql";
import { isVisible } from "../../util";
import { visibilityFiltersJson } from "../../util";
import { checkPermissions } from "./util";
import { userPermissions } from "../../../types/auth";
import { stripTZ } from "../datetime-no-tz";
// Fetch bookingConfirmation(s) without providing a bookingConfirmation ID.
// isVisible() validates whether the user is allowed to see the results,
// with allowances for integration and analytics.
export const getBookingConfirmationsByQuery = async (
  _: any,
  {
    first = 50,
    after = 0,
    number: _number, // `number` is a reserved keyword
    bookingRequestNumber,
    buyerId,
    supplierId,
    consigneeId,
    forwarderId,
    updatedSince
  }: GetByArgs,
  context: GraphQLContext
) => {
  const bookingConfirmationQuery = getManager("postgres").getRepository(BookingConfirmation).createQueryBuilder("bc")
  if (_number) {
    bookingConfirmationQuery.andWhere(`bc.fields->>'number' LIKE '%${_number}%'`);
  }
  if (bookingRequestNumber) {
    bookingConfirmationQuery.andWhere(`bc.fields->>'bookingRequestNumber' LIKE '%${bookingRequestNumber}%'`);
  }
  if (buyerId) {
    bookingConfirmationQuery.andWhere("bc.fields->>'buyerId' = :buyerId", { buyerId });
  }
  if (supplierId) {
    bookingConfirmationQuery.andWhere("bc.fields->>'supplierId' = :supplierId", { supplierId });
  }
  if (forwarderId) {
    bookingConfirmationQuery.andWhere("bc.fields->>'forwarderId' = :forwarderId", { forwarderId });
  }
  if (consigneeId) {
    bookingConfirmationQuery.andWhere("bc.fields->>'consigneeId' = :consigneeId", { consigneeId });
  }

  if (updatedSince) {
    const _updatedSince = moment(stripTZ(updatedSince)).format("YYYYMMDD");
    bookingConfirmationQuery.andWhere("bc.updatedAt >= :_updatedSince", { _updatedSince });
  }


  const isInterationOrAnalytics =
    checkPermissions(context.permissions, [userPermissions.INTEGRATION, userPermissions.ANALYTICS]);
  if (!isInterationOrAnalytics) {
    bookingConfirmationQuery.andWhere(visibilityFiltersJson(context.orgId, "bc.fields"));
  }


  const [results, total] = await bookingConfirmationQuery
    .skip(after)
    .take(min([first, 1000]))
    .getManyAndCount();

  // Prime data loader with orders for subsequent queries.
  const pageNodes: { node: BookingConfirmation; cursor: string; }[] = [];
  results.forEach((bc, index) => {
    dataLoaders.bookingConfirmationLoader.prime(bc.id, bc);
    if (isVisible(context)(bc?.fields)) {
      pageNodes.push({
        node: bc,
        cursor: bc.id,
      });
    }
  });
  return {
    totalCount: total,
    edges: pageNodes,
  };
};
