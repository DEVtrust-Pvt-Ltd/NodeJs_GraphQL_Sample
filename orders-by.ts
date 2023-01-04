import { min } from "lodash";
import moment from "moment";
import { dataLoaders } from "..";
import { Order } from "../../../models/mssql/order";
import { GetByArgs } from "../../../types/common";
import { GraphQLContext } from "../../../types/graphql";
import { stripTZ } from "../datetime-no-tz";
import { isVisible } from "../../util";
import { visibilityFilters } from "../../util";
import { checkPermissions } from "./util";
import { userPermissions } from "../../../types/auth";
// Fetch order(s) without providing an ID.
// isVisible() validates whether the user is allowed to see the results,
// with allowances for integration and analytics.
export const ordersByQuery = async (
  _: any,
  {
    first = 50,
    after = 0,
    number: _number, // `number` is a reserved keyword
    buyerId,
    supplierId,
    forwarderId,
    consigneeId,
    updatedSince,
  }: GetByArgs,
  context: GraphQLContext
) => {
  const orderQuery = Order.createQueryBuilder("order");
  if (_number) {
    orderQuery.andWhere(`order.PoNumber LIKE '%${_number}%'`);
  }
  if (buyerId) {
    orderQuery.andWhere("order.EntityOid_Buyer = :buyerId", { buyerId });
  }
  if (supplierId) {
    orderQuery.andWhere("order.EntityOid_Supplier = :supplierId", { supplierId });
  }
  if (forwarderId) {
    orderQuery.andWhere("order.EntityOid_Forwarder = :forwarderId", { forwarderId });
  }
  if (consigneeId) {
    orderQuery.andWhere("order.EntityOid_Consignee = :consigneeId", { consigneeId });
  }
  if (updatedSince) {
    const _updatedSince = moment(stripTZ(updatedSince)).format('YYYYMMDD');
    orderQuery.andWhere("order.LastUpdatedDate >= :_updatedSince", { _updatedSince });
  }

  const isInterationOrAnalytics =
    checkPermissions(context.permissions, [userPermissions.INTEGRATION, userPermissions.ANALYTICS]);
  if (!isInterationOrAnalytics) {
    orderQuery.andWhere(visibilityFilters(context.orgId, "order"));
  }

  const [result, total] = await orderQuery
    .skip(after)
    .take(min([first, 1000]))
    .getManyAndCount();

  // Prime data loader with orders for subsequent queries.
  const pageNodes: { node: Order; cursor: string; }[] = [];
  result.forEach(o => {
    dataLoaders.orderLoader.prime(o.id, o);
    if (isVisible(context)(o)) {
      pageNodes.push({
        node: o,
        cursor: o.id,
      });
    }
  });
  return {
    totalCount: total,
    edges: pageNodes,
  };
};
