import { z } from "zod";
import {
  type OcppCall,
  type OcppCallResult,
  OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema, IdTagInfoSchema, IdTokenSchema } from "./_common";
import { meterValuesOcppMessage } from "./meterValues";

const StartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  idTag: IdTokenSchema,
  meterStart: z.number().int(),
  reservationId: z.number().int().nullish(),
  timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
  StartTransactionReqType,
  StartTransactionResType
> {
  resHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<StartTransactionReqType>>,
    result: OcppCallResult<z.infer<StartTransactionResType>>,
  ): Promise<void> => {
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: result.payload.transactionId,
      idTag: call.payload.idTag,
      connectorId: call.payload.connectorId,
      meterValuesCallback: async (transactionState) => {
        const elapsedSec = (Date.now() - transactionState.startedAt.getTime()) / 1000;

        // Simulate realistic single-phase ~7.4kW charging (32A offered)
        const offeredCurrentA = 32;
        const voltageL1 = 230 + (Math.random() * 4 - 2);
        const voltageL2 = 230 + (Math.random() * 4 - 2);
        const voltageL3 = 230 + (Math.random() * 4 - 2);

        // Actual draw slightly below offered with small jitter
        const drawCurrentA = offeredCurrentA - 0.8 + (Math.random() * 0.4 - 0.2);
        const powerW = voltageL1 * drawCurrentA;
        const energyKwh = (powerW * elapsedSec) / 3600000;

        // Simulate temperatures with small jitter
        const bodyTemp = 20 + (Math.random() * 2 - 1);
        const cableTemp = 19 + (Math.random() * 2 - 1);

        vcp.send(
          meterValuesOcppMessage.request({
            connectorId: call.payload.connectorId,
            transactionId: result.payload.transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: energyKwh.toFixed(3),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                    context: "Sample.Periodic",
                    location: "Outlet",
                  },
                  {
                    value: offeredCurrentA.toFixed(2),
                    measurand: "Current.Offered",
                    unit: "A",
                    context: "Sample.Periodic",
                    location: "Outlet",
                  },
                  {
                    value: bodyTemp.toFixed(2),
                    measurand: "Temperature",
                    unit: "Celsius",
                    context: "Sample.Periodic",
                    location: "Body",
                  },
                  {
                    value: cableTemp.toFixed(2),
                    measurand: "Temperature",
                    unit: "Celsius",
                    context: "Sample.Periodic",
                    location: "Cable",
                  },
                  {
                    value: voltageL1.toFixed(2),
                    measurand: "Voltage",
                    unit: "V",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L1",
                  },
                  {
                    value: voltageL2.toFixed(2),
                    measurand: "Voltage",
                    unit: "V",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L2",
                  },
                  {
                    value: voltageL3.toFixed(2),
                    measurand: "Voltage",
                    unit: "V",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L3",
                  },
                  {
                    value: drawCurrentA.toFixed(2),
                    measurand: "Current.Import",
                    unit: "A",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L1",
                  },
                  {
                    value: "0.00",
                    measurand: "Current.Import",
                    unit: "A",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L2",
                  },
                  {
                    value: "0.00",
                    measurand: "Current.Import",
                    unit: "A",
                    context: "Sample.Periodic",
                    location: "Outlet",
                    phase: "L3",
                  },
                  {
                    value: powerW.toFixed(2),
                    measurand: "Power.Active.Import",
                    unit: "W",
                    context: "Sample.Periodic",
                    location: "Outlet",
                  },
                ],
              },
            ],
          }),
        );
      },
    });
  };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
  "StartTransaction",
  StartTransactionReqSchema,
  StartTransactionResSchema,
);
