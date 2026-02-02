require("dotenv").config();

import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "./src/v16/messages/statusNotification";
import { VCP } from "./src/vcp";

const WS_URL = "ws://proxy.plugchoice.com/v1";

// Selected chargers: Count 1 only (for testing)
const chargers = [
  {
    cpId: "T1845123031855--D",
    vendor: "ABB",
    model: "MD_TERRA_D",
    serialNumber: "T1845123031855--D",
    firmwareVersion: "4.0.4.22",
    connectors: 2,
    meterType: "MID",
    iccid: "8986647319048838343",
    imsi: "204869678867348",
    meterSerialNumber: "D6J567015",
  },
];

async function spawnCharger(charger: (typeof chargers)[0]) {
  const vcp = new VCP({
    endpoint: WS_URL,
    chargePointId: charger.cpId,
    ocppVersion: OcppVersion.OCPP_1_6,
    config: {
      chargePointVendor: charger.vendor,
      chargePointModel: charger.model,
      chargePointSerialNumber: charger.serialNumber,
      firmwareVersion: charger.firmwareVersion,
      numberOfConnectors: charger.connectors,
      meterType: charger.meterType,
      meterSerialNumber: charger.meterSerialNumber,
    },
  });

  await vcp.connect();

  vcp.send(
    bootNotificationOcppMessage.request({
      chargePointVendor: charger.vendor,
      chargePointModel: charger.model,
      chargePointSerialNumber: charger.serialNumber,
      firmwareVersion: charger.firmwareVersion,
      meterType: charger.meterType,
      iccid: charger.iccid,
      imsi: charger.imsi,
      meterSerialNumber: charger.meterSerialNumber,
    })
  );

  // Send status notification for connector 0 (the charge point itself)
  vcp.send(
    statusNotificationOcppMessage.request({
      connectorId: 0,
      errorCode: "NoError",
      status: "Available",
    })
  );

  // Send status notification for each physical connector (1, 2, ...)
  for (let i = 1; i <= charger.connectors; i++) {
    vcp.send(
      statusNotificationOcppMessage.request({
        connectorId: i,
        errorCode: "NoError",
        status: "Available",
      })
    );
  }

  console.log(`[SPAWNED] ${charger.cpId} (${charger.vendor} ${charger.model}) - ${charger.connectors} connector(s)`);
  return vcp;
}

(async () => {
  console.log(`Connecting ${chargers.length} chargers to ${WS_URL}...\n`);

  const vcps: VCP[] = [];

  for (const charger of chargers) {
    try {
      const vcp = await spawnCharger(charger);
      vcps.push(vcp);
    } catch (error) {
      console.error(`[FAILED] ${charger.cpId}: ${error}`);
    }
  }

  console.log(`\n${vcps.length}/${chargers.length} chargers online.`);
})();
