import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";

const GetConfigurationReqSchema = z.object({
  key: z.array(z.string().max(50)).nullish(),
});
type GetConfigurationReqType = typeof GetConfigurationReqSchema;

const GetConfigurationResSchema = z.object({
  configurationKey: z
    .array(
      z.object({
        key: z.string().max(50),
        readonly: z.boolean(),
        value: z.string().max(500).nullish(),
      })
    )
    .nullish(),
  unknownKey: z.array(z.string().max(50)).nullish(),
});
type GetConfigurationResType = typeof GetConfigurationResSchema;

interface ConfigurationEntry {
  key: string;
  readonly: boolean;
  value: string;
}

// Build configuration entries from VCP config
function buildConfigurationKeys(vcp: VCP): ConfigurationEntry[] {
  const config = vcp.config;

  return [
    // Core Profile
    {
      key: "SupportedFeatureProfiles",
      readonly: true,
      value: "Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger",
    },
    {
      key: "NumberOfConnectors",
      readonly: true,
      value: String(config.numberOfConnectors ?? 1),
    },
    {
      key: "HeartbeatInterval",
      readonly: false,
      value: String(config.heartbeatInterval ?? 300),
    },
    {
      key: "ConnectionTimeOut",
      readonly: false,
      value: String(config.connectionTimeOut ?? 60),
    },
    {
      key: "GetConfigurationMaxKeys",
      readonly: true,
      value: "99",
    },
    {
      key: "MeterValueSampleInterval",
      readonly: false,
      value: String(config.meterValueSampleInterval ?? 15),
    },
    {
      key: "MeterValuesSampledData",
      readonly: false,
      value: "Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage",
    },
    {
      key: "MeterValuesAlignedData",
      readonly: false,
      value: "Energy.Active.Import.Register",
    },
    {
      key: "ClockAlignedDataInterval",
      readonly: false,
      value: "0",
    },
    // Authorization
    {
      key: "AuthorizeRemoteTxRequests",
      readonly: false,
      value: String(config.authorizeRemoteTxRequests ?? false),
    },
    {
      key: "LocalAuthorizeOffline",
      readonly: false,
      value: String(config.localAuthorizeOffline ?? true),
    },
    {
      key: "LocalPreAuthorize",
      readonly: false,
      value: String(config.localPreAuthorize ?? false),
    },
    {
      key: "AuthorizationCacheEnabled",
      readonly: false,
      value: "true",
    },
    // Transactions
    {
      key: "StopTransactionOnEVSideDisconnect",
      readonly: false,
      value: "true",
    },
    {
      key: "StopTransactionOnInvalidId",
      readonly: false,
      value: "true",
    },
    {
      key: "UnlockConnectorOnEVSideDisconnect",
      readonly: false,
      value: "true",
    },
    // Smart Charging
    {
      key: "ChargeProfileMaxStackLevel",
      readonly: true,
      value: "99",
    },
    {
      key: "ChargingScheduleAllowedChargingRateUnit",
      readonly: true,
      value: "Current,Power",
    },
    {
      key: "ChargingScheduleMaxPeriods",
      readonly: true,
      value: "24",
    },
    {
      key: "MaxChargingProfilesInstalled",
      readonly: true,
      value: "10",
    },
    // Local Auth List
    {
      key: "LocalAuthListEnabled",
      readonly: false,
      value: "true",
    },
    {
      key: "LocalAuthListMaxLength",
      readonly: true,
      value: "100",
    },
    {
      key: "SendLocalListMaxLength",
      readonly: true,
      value: "100",
    },
    // Reservation
    {
      key: "ReserveConnectorZeroSupported",
      readonly: true,
      value: "true",
    },
    // Connector
    {
      key: "ConnectorPhaseRotation",
      readonly: false,
      value: Array.from(
        { length: config.numberOfConnectors ?? 1 },
        (_, i) => `${i}.RST`
      ).join(","),
    },
    {
      key: "ConnectorPhaseRotationMaxLength",
      readonly: true,
      value: String((config.numberOfConnectors ?? 1) + 1),
    },
    // Charger identity (from config)
    {
      key: "ChargePointVendor",
      readonly: true,
      value: config.chargePointVendor ?? "Unknown",
    },
    {
      key: "ChargePointModel",
      readonly: true,
      value: config.chargePointModel ?? "Unknown",
    },
    {
      key: "ChargePointSerialNumber",
      readonly: true,
      value: config.chargePointSerialNumber ?? "Unknown",
    },
    {
      key: "FirmwareVersion",
      readonly: true,
      value: config.firmwareVersion ?? "1.0.0",
    },
    {
      key: "MeterType",
      readonly: true,
      value: config.meterType ?? "Unknown",
    },
    {
      key: "MeterSerialNumber",
      readonly: true,
      value: config.meterSerialNumber ?? "Unknown",
    },
  ];
}

class GetConfigurationOcppMessage extends OcppIncoming<
  GetConfigurationReqType,
  GetConfigurationResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetConfigurationReqType>>
  ): Promise<void> => {
    const allKeys = buildConfigurationKeys(vcp);
    const requestedKeys = call.payload.key;

    // If no keys requested, return all
    if (!requestedKeys || requestedKeys.length === 0) {
      vcp.respond(
        this.response(call, {
          configurationKey: allKeys,
          unknownKey: [],
        })
      );
      return;
    }

    // Filter by requested keys
    const knownKeyMap = new Map(allKeys.map((k) => [k.key, k]));
    const configurationKey: ConfigurationEntry[] = [];
    const unknownKey: string[] = [];

    for (const key of requestedKeys) {
      const entry = knownKeyMap.get(key);
      if (entry) {
        configurationKey.push(entry);
      } else {
        unknownKey.push(key);
      }
    }

    vcp.respond(
      this.response(call, {
        configurationKey,
        unknownKey,
      })
    );
  };
}

export const getConfigurationOcppMessage = new GetConfigurationOcppMessage(
  "GetConfiguration",
  GetConfigurationReqSchema,
  GetConfigurationResSchema
);
