import { ApolloError } from "apollo-server";

import { EnvironmentManager } from "../../../managers/EnvironmentManager";

import { Company } from "../../../models/mssql/generic-entity/company";
import { User } from "../../../models/mssql/generic-entity/user";
import { CompanyType } from "../../../types/entities";
import { CreateOrderInput, OrderCompanyInput } from "../../../types/order";
import { dataLoaders } from "../../resolvers";
import { orderRejectedTemplate, sendEmail } from "../../resolvers/query/util";
import { getCountryFromCode } from "../../util/country";
import { connectUserToOrg } from "../../util/user";
import { createOrganization } from "../organization/create";
import { validateAndCreateExternalIds } from "../organization/create-external-ids";
import { createOrgRelationships } from "../organization/create-relationships";

const createOrderOrganization = async ({
  orgData,
  permissions,
  userId,
  adminEmail,
}: {
  orgData: OrderCompanyInput;
  permissions: [string];
  userId: string;
  adminEmail: string;
}) => {
  const { countryCode, ...rest } = orgData;
  const countryId = (await getCountryFromCode(countryCode))?.id;
  const orgRow = await createOrganization({
    orgData: { ...rest, countryId, adminEmail },
    permissions,
    userId,
    skipEmailValidation: true,
  });
  return orgRow;
};

export const validateOrderOrg = async (
  {
    fields = {},
    purchaseOrderNumber,
    permissions,
    userId = "",
    buyer = {} as Company,
  }: {
    fields: Partial<CreateOrderInput>;
      purchaseOrderNumber: string;
      permissions: [string];
      userId: string;
      buyer: Company;
    }
) => {
  const env = EnvironmentManager.getInstance();

  const user = await User.findOne(userId);

  const {
    supplierId,
    supplier: supplierData,
    forwarderId,
    forwarder: forwarderData,
    consigneeId,
    consignee: consigneeData,
    brokerId,
    broker: brokerData,
    agentId,
    agent: agentData,
    truckerId,
    trucker: truckerData,
  } = fields;

  const buyerPreferences = JSON.parse(buyer?.preferencesString);
  const newAdminUsers = buyerPreferences.companyAutoCreateContactList;
  const [firstAdminUserId] = newAdminUsers;
  const firstAdminUser = await dataLoaders.entityLoader.load(firstAdminUserId);

  const orgEntities = [
    {
      orgId: supplierId,
      orgData: supplierData,
      role: CompanyType.SUPPLIER,
      required: true,
    },
    {
      orgId: forwarderId,
      orgData: forwarderData,
      role: CompanyType.FORWARDER,
      required: true,
    },
    {
      orgId: consigneeId,
      orgData: consigneeData,
      role: CompanyType.CONSIGNEE,
      required: true,
    },
    {
      orgId: agentId,
      orgData: agentData,
      role: CompanyType.AGENT,
      required: false,
    },
    {
      orgId: brokerId,
      orgData: brokerData,
      role: CompanyType.BROKER,
      required: false,
    },
    {
      orgId: truckerId,
      orgData: truckerData,
      role: CompanyType.TRUCKER,
      required: false,
    },
  ];

  const orderOrgs: Record<string, any> = {};
  for (const orgEntity of orgEntities) {
    const { orgId, orgData, role, required } = orgEntity;
    if (!orgId && !orgData && required) {
      for (const adminUserId of newAdminUsers) {
        const adminUser = await dataLoaders.entityLoader.load(adminUserId);
        await sendEmail({
          to: adminUser.email,
          from: env.variables.MASTER_EMAIL,
          subject: "New Company Exception",
          html: orderRejectedTemplate({
            firstName: user?.firstName,
            lastName: user?.lastName,
            orderNumber: purchaseOrderNumber,
          }),
        });
      }
      throw new ApolloError(`Both ${role}Id and ${role} can't be empty`);
    }

    if (!orgId && orgData) {
      const org = await createOrderOrganization({
        orgData,
        permissions,
        userId,
        adminEmail: firstAdminUser.email,
      });

      if (org) {
        for (const adminUserId of newAdminUsers) {
          const adminUser = await dataLoaders.entityLoader.load(adminUserId);
          await connectUserToOrg({
            userEmail: adminUser.email,
            orgId: org.id,
          });
        }

        await createOrgRelationships([
          {
            fromOrgId: buyer.id,
            fromRole: CompanyType.BUYER,
            toOrgId: org.id,
            toRole: role,
          },
        ]);

        if (orgData.externalID) {
          await validateAndCreateExternalIds([
            {
              orgId: org.id,
              externalId: orgData.externalID,
              externalSystemInstanceId: "Chain.io",
            },
          ]);
        }

        const orderOrgIdKey = `${role}Id`;
        Object.assign(orderOrgs, { [orderOrgIdKey]: org.id });
      }
    }
  }

  return orderOrgs;
};
