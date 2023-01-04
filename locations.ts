import { Brackets, SelectQueryBuilder } from "typeorm";
import { dataLoaders } from "..";
import { Location } from "../../../models/mssql/location";
import { userPermissions } from "../../../types/auth";
import { GraphQLContext } from "../../../types/graphql";
import { checkPermissions } from "./util";
import { GetMultiArgs } from "../../../types/common";
import { GenericLookup } from "../../../models/mssql/generic-lookup";
import { LocationIdentifier } from "../../../models/mssql/location-identifier";

const validSearchFields = [
  "location.Name",
];

type WhereExpressionType = {
  searchString: string;
  params: { searchText: string };
};

const createWhereExpression = (
  fieldName: string,
  search: string
): WhereExpressionType => {
  return {
    searchString: `${fieldName} like :searchText`,
    params: {
      searchText: `%${search}%`,
    },
  };
};

export const locationsQueryResolver = async (
  _: any,
  args: GetMultiArgs,
  { orgId: contextOrgId, permissions }: GraphQLContext
) => {
  const { orgId: inputOrgId } = args;

  const first = Math.min(args.first || 5, 1000);
  const after = args.after || 0;
  const orderByKey = args.orderByKey || "name";
  const orderByValue = args.orderByValue || "ASC";
  const search = args.search;

  let orgId = contextOrgId;
  if (checkPermissions(permissions, [userPermissions.ANALYTICS, userPermissions.INTEGRATION])) {
    orgId = inputOrgId || contextOrgId;
  }
  const locationTypeQuery = (): SelectQueryBuilder<Location> =>
    queryBuilder
      .addSelect("locationType.Value", "locationTypeValue")
      .leftJoin(
        GenericLookup,
        "locationType",
        "locationType.Oid = location.lkpLocationTypeOid"
      )
      .orderBy("locationTypeValue", orderByValue);

  const consolidationQuery = (): SelectQueryBuilder<Location> =>
    queryBuilder.orderBy(`location.isConsolidationLocation`, orderByValue);

  const pickupLocationQuery = (): SelectQueryBuilder<Location> =>
    queryBuilder.orderBy(`location.isPickupLocation`, orderByValue);

  const defaultQuery = (): SelectQueryBuilder<Location> =>
    queryBuilder.orderBy(`location.${orderByKey}`, orderByValue);

  const queryMap: Map<string, () => SelectQueryBuilder<Location>> = new Map([
    ["locationTypeQuery", locationTypeQuery],
    ["consolidationQuery", consolidationQuery],
    ["pickupLocationQuery", pickupLocationQuery],
    ["defaultQuery", defaultQuery],
  ]);

  const queryBuilder = Location.createQueryBuilder("location");
  queryBuilder.where({ orgId, isActive: true });
  const querySet: Set<string> = new Set();

  switch (orderByKey) {
    case "LOCATIONTYPEVALUE":
      querySet.add("locationTypeQuery");
      break;
    case "CONSOLIDATIONLOCATION":
      querySet.add("consolidationQuery");
      break;
    case "PICKUPLOCATION":
      querySet.add("pickupLocationQuery");
      break;
    default:
      querySet.add("defaultQuery");
  }

  Array.from(querySet).map((key) => queryMap.get(key)());

  if (search) {
    const brackets = new Brackets((sqb) => {
      validSearchFields.map((field, idx) => {
        const { searchString, params } = createWhereExpression(field, search);
        if (idx === 0) {
          sqb.andWhere(searchString, params);
          return;
        }
        sqb.orWhere(searchString, params);
      });
    });
    queryBuilder.andWhere(brackets);
  }

  const [locations, totalCount] = await queryBuilder
    .skip(after)
    .take(first)
    .getManyAndCount();

  const locationNodes: { node: Location; cursor: string; }[] = [];
  locations.forEach(l => {
    if (l instanceof Error) return;

    // Prime data loader with locations for subsequent queries.
    dataLoaders.locationLoader.prime(l.id, l);

    locationNodes.push({
      node: l,
      cursor: l.id,
    });
  });

  return {
    totalCount,
    edges: locationNodes,
  };
};

/**
 * check if locationIdentifier is unique or not.
 * it returns true if locationIdentifier is unique and false if not.
 */
export const validateLocationIdentifier = async (
  _: any,
  args: any
) => {
  const { locationIdentifier } = args;

  const locationsWithIdentifier = await LocationIdentifier.find({
    identifier: locationIdentifier
  });

  if (locationsWithIdentifier?.length) {
    return false;
  }

  return true;
};
