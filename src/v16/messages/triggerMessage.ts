import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema } from "./_common";
import { bootNotificationOcppMessage } from "./bootNotification";
import { heartbeatOcppMessage } from "./heartbeat";
import { statusNotificationOcppMessage } from "./statusNotification";

const TriggerMessageReqSchema = z.object({
  requestedMessage: z.enum([
    "BootNotification",
    "DiagnosticsStatusNotification",
    "FirmwareStatusNotification",
    "Heartbeat",
    "MeterValues",
    "StatusNotification",
  ]),
  connectorId: ConnectorIdSchema.nullish(),
});
type TriggerMessageReqType = typeof TriggerMessageReqSchema;

const TriggerMessageResSchema = z.object({
  status: z.enum(["Accepted", "Rejected", "NotImplemented"]),
});
type TriggerMessageResType = typeof TriggerMessageResSchema;

class TriggerMessageOcppMessage extends OcppIncoming<
  TriggerMessageReqType,
  TriggerMessageResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<TriggerMessageReqType>>,
  ): Promise<void> => {
    const requested = call.payload.requestedMessage;

    switch (requested) {
      case "BootNotification": {
        vcp.respond(this.response(call, { status: "Accepted" }));
        vcp.send(
          bootNotificationOcppMessage.request({
            chargePointVendor: vcp.config.chargePointVendor ?? "Unknown",
            chargePointModel: vcp.config.chargePointModel ?? "Unknown",
            chargePointSerialNumber: vcp.config.chargePointSerialNumber,
            firmwareVersion: vcp.config.firmwareVersion,
            meterType: vcp.config.meterType,
            meterSerialNumber: vcp.config.meterSerialNumber,
          }),
        );
        break;
      }
      case "Heartbeat": {
        vcp.respond(this.response(call, { status: "Accepted" }));
        vcp.send(heartbeatOcppMessage.request({}));
        break;
      }
      case "StatusNotification": {
        vcp.respond(this.response(call, { status: "Accepted" }));
        const connectorId = call.payload.connectorId ?? 0;
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId,
            errorCode: "NoError",
            status: "Available",
          }),
        );
        break;
      }
      default:
        vcp.respond(this.response(call, { status: "NotImplemented" }));
    }
  };
}

export const triggerMessageOcppMessage = new TriggerMessageOcppMessage(
  "TriggerMessage",
  TriggerMessageReqSchema,
  TriggerMessageResSchema,
);
