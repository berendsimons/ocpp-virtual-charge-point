import { OcppVersion } from "../src/ocppVersion";
import { bootNotificationOcppMessage } from "../src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "../src/v16/messages/statusNotification";
import { meterValuesOcppMessage } from "../src/v16/messages/meterValues";
import { authorizeOcppMessage } from "../src/v16/messages/authorize";
import { startTransactionOcppMessage } from "../src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "../src/v16/messages/stopTransaction";
import { VCP } from "../src/vcp";
import { call } from "../src/messageFactory";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CarSimulator, CAR_PROFILES, type CarProfile } from "./carSimulator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ChargerConfig {
  cpId: string;
  vendor: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  connectors: number;
  phases: 1 | 3; // 1 = L1+N, 3 = L1+L2+L3+N
  meterType?: string;
  meterSerialNumber?: string;
  iccid?: string;
  imsi?: string;
}

export interface ConnectorState {
  connectorId: number;
  status: string;
  errorCode: string;
  currentImport: number; // Amps - offered current (EVSE side)
  powerImport: number; // Watts
  energyImported: number; // Wh cumulative
  transactionId?: number;
  carSimulator?: CarSimulator;
}

export interface ManagedCharger {
  config: ChargerConfig;
  vcp: VCP | null;
  connected: boolean;
  connectors: ConnectorState[];
  meterInterval?: NodeJS.Timeout;
}

const CHARGERS_FILE = path.join(__dirname, "..", "chargers.json");
const DEFAULT_WS_URL = "ws://proxy.plugchoice.com/v1";

export class ChargerManager {
  private chargers: Map<string, ManagedCharger> = new Map();
  private wsUrl: string;

  constructor(wsUrl?: string) {
    this.wsUrl = wsUrl || process.env.WS_URL || DEFAULT_WS_URL;
    this.loadChargers();
  }

  private loadChargers() {
    try {
      if (fs.existsSync(CHARGERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CHARGERS_FILE, "utf-8"));
        for (const config of data.chargers || []) {
          // Default phases to 3 for old configs without it
          if (!config.phases) config.phases = 3;
          this.chargers.set(config.cpId, {
            config,
            vcp: null,
            connected: false,
            connectors: this.initConnectors(config.connectors),
          });
        }
        console.log(`Loaded ${this.chargers.size} charger configs from file`);
      }
    } catch (err) {
      console.error("Failed to load chargers.json:", err);
    }
  }

  private saveChargers() {
    const data = {
      chargers: Array.from(this.chargers.values()).map((c) => c.config),
    };
    fs.writeFileSync(CHARGERS_FILE, JSON.stringify(data, null, 2));
  }

  private initConnectors(count: number): ConnectorState[] {
    const connectors: ConnectorState[] = [];
    for (let i = 1; i <= count; i++) {
      connectors.push({
        connectorId: i,
        status: "Available",
        errorCode: "NoError",
        currentImport: 0,
        powerImport: 0,
        energyImported: 0,
      });
    }
    return connectors;
  }

  getWsUrl(): string {
    return this.wsUrl;
  }

  setWsUrl(url: string) {
    this.wsUrl = url;
  }

  getAllChargers(): Array<{
    cpId: string;
    config: ChargerConfig;
    connected: boolean;
    connectors: any[];
  }> {
    return Array.from(this.chargers.entries()).map(([cpId, charger]) => ({
      cpId,
      config: charger.config,
      connected: charger.connected,
      connectors: charger.connectors.map((c) =>
        this.serializeConnector(cpId, c)
      ),
    }));
  }

  getCharger(cpId: string): ManagedCharger | undefined {
    return this.chargers.get(cpId);
  }

  addCharger(config: ChargerConfig): boolean {
    if (this.chargers.has(config.cpId)) {
      return false;
    }
    this.chargers.set(config.cpId, {
      config,
      vcp: null,
      connected: false,
      connectors: this.initConnectors(config.connectors),
    });
    this.saveChargers();
    return true;
  }

  removeCharger(cpId: string): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    if (charger.vcp && charger.connected) {
      this.stopMeterValues(cpId);
      // Don't call close() as it exits the process
    }
    this.chargers.delete(cpId);
    this.saveChargers();
    return true;
  }

  async connectCharger(cpId: string): Promise<boolean> {
    const charger = this.chargers.get(cpId);
    if (!charger || charger.connected) return false;

    // Validate WebSocket URL
    if (!this.wsUrl || !this.wsUrl.startsWith("ws://") && !this.wsUrl.startsWith("wss://")) {
      console.error(`[FAILED] ${cpId}: Invalid WebSocket URL: ${this.wsUrl}`);
      return false;
    }

    try {
      const vcp = new VCP({
        endpoint: this.wsUrl,
        chargePointId: cpId,
        ocppVersion: OcppVersion.OCPP_1_6,
        exitOnClose: false, // Don't exit the dashboard process on disconnect
        onClose: (code, reason) => {
          console.log(`[DISCONNECTED] ${cpId}: code=${code}, reason=${reason}`);
          const ch = this.chargers.get(cpId);
          if (ch) {
            ch.connected = false;
            ch.vcp = null;
            this.stopMeterValues(cpId);
          }
        },
        onError: (err) => {
          console.error(`[ERROR] ${cpId}: ${err.message}`);
          const ch = this.chargers.get(cpId);
          if (ch) {
            ch.connected = false;
            ch.vcp = null;
            this.stopMeterValues(cpId);
          }
        },
        config: {
          chargePointVendor: charger.config.vendor,
          chargePointModel: charger.config.model,
          chargePointSerialNumber: charger.config.serialNumber,
          firmwareVersion: charger.config.firmwareVersion,
          numberOfConnectors: charger.config.connectors,
          meterType: charger.config.meterType,
          meterSerialNumber: charger.config.meterSerialNumber,
        },
      });

      await vcp.connect();

      charger.vcp = vcp;

      // Brief delay to let CSMS/proxy finish connection setup before sending
      await new Promise((r) => setTimeout(r, 500));

      // Send BootNotification (await to ensure it's actually sent)
      console.log(`[BOOT] ${cpId}: Sending BootNotification...`);
      await vcp.sendAsync(
        bootNotificationOcppMessage.request({
          chargePointVendor: charger.config.vendor,
          chargePointModel: charger.config.model,
          chargePointSerialNumber: charger.config.serialNumber,
          firmwareVersion: charger.config.firmwareVersion,
          meterType: charger.config.meterType,
          iccid: charger.config.iccid,
          imsi: charger.config.imsi,
          meterSerialNumber: charger.config.meterSerialNumber,
        })
      );
      console.log(`[BOOT] ${cpId}: BootNotification sent`);

      charger.connected = true;

      // Send StatusNotification for connector 0 (charge point itself)
      vcp.send(
        statusNotificationOcppMessage.request({
          connectorId: 0,
          errorCode: "NoError",
          status: "Available",
        })
      );

      // Send StatusNotification for each connector
      for (const connector of charger.connectors) {
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId: connector.connectorId,
            errorCode: connector.errorCode,
            status: connector.status,
          })
        );
      }

      // Start meter values reporting
      this.startMeterValues(cpId);

      console.log(`[CONNECTED] ${cpId}`);
      return true;
    } catch (err) {
      console.error(`[FAILED] ${cpId}:`, err);
      charger.connected = false;
      charger.vcp = null;
      return false;
    }
  }

  async connectAll(): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const cpId of this.chargers.keys()) {
      const charger = this.chargers.get(cpId);
      if (charger && !charger.connected) {
        const result = await this.connectCharger(cpId);
        if (result) success++;
        else failed++;
      }
    }

    return { success, failed };
  }

  disconnectCharger(cpId: string): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger || !charger.connected) return false;

    try {
      this.stopMeterValues(cpId);

      if (charger.vcp) {
        charger.vcp.close();
      }

      charger.connected = false;
      charger.vcp = null;

      console.log(`[DISCONNECTED] ${cpId}`);
      return true;
    } catch (err) {
      console.error(`[DISCONNECT FAILED] ${cpId}:`, err);
      return false;
    }
  }

  private startMeterValues(cpId: string) {
    const charger = this.chargers.get(cpId);
    if (!charger || !charger.vcp) return;

    // Send meter values every 15 seconds for connectors that are charging
    charger.meterInterval = setInterval(() => {
      if (!charger.vcp || !charger.connected) return;

      for (const connector of charger.connectors) {
        if (connector.status === "Charging" && connector.currentImport > 0) {
          const chargerPhases = charger.config.phases || 3;
          let perPhaseCurrent: number;
          let effectivePhases: number;
          let socPercent: number | undefined;

          if (connector.carSimulator) {
            // Car simulator mode: tick the simulation
            const sim = connector.carSimulator;
            const result = sim.tick(15);
            perPhaseCurrent = result.currentA;
            effectivePhases = sim.getEffectivePhases();
            socPercent = sim.getSocPercent();

            // SuspendedEV override: when car reaches 100% SoC
            if (socPercent >= 100 && result.currentA === 0) {
              connector.status = "SuspendedEV";
              connector.powerImport = 0;
              if (charger.vcp && charger.connected) {
                charger.vcp.send(
                  statusNotificationOcppMessage.request({
                    connectorId: connector.connectorId,
                    errorCode: connector.errorCode as any,
                    status: "SuspendedEV" as any,
                  })
                );
              }
            }
          } else {
            // Manual mode: current flows on all charger phases
            perPhaseCurrent = connector.currentImport;
            effectivePhases = chargerPhases;
          }

          // Per-phase current: only active phases carry current
          const currentL1 = effectivePhases >= 1 ? perPhaseCurrent : 0;
          const currentL2 = effectivePhases >= 2 ? perPhaseCurrent : 0;
          const currentL3 = effectivePhases >= 3 ? perPhaseCurrent : 0;

          // Voltage model: sags under load, stays near no-load when idle
          // No-load sits slightly above 230V nominal (~232V)
          // Each amp causes ~0.15V drop (typical residential impedance)
          // Tight jitter (±0.5V) so loaded vs idle phases are clearly distinct
          const noLoadV = 232;
          const dropPerAmp = 0.15;
          const voltageL1 = noLoadV - (currentL1 * dropPerAmp) + (Math.random() - 0.5);
          const voltageL2 = noLoadV - (currentL2 * dropPerAmp) + (Math.random() - 0.5);
          const voltageL3 = noLoadV - (currentL3 * dropPerAmp) + (Math.random() - 0.5);

          // Calculate power from actual V * I per phase (realistic)
          const reportPower =
            voltageL1 * currentL1 +
            voltageL2 * currentL2 +
            voltageL3 * currentL3;

          // Energy increment from actual power * time
          const energyIncrementWh = (reportPower * 15) / 3600;
          connector.energyImported += energyIncrementWh;
          connector.powerImport = reportPower;

          // Simulate temperatures with small jitter
          const bodyTemp = 20 + (Math.random() * 2 - 1);
          const cableTemp = 19 + (Math.random() * 2 - 1);

          const sampledValue: Array<{
            value: string;
            measurand: string;
            unit: string;
            context: string;
            phase?: string;
            location?: string;
          }> = [
            {
              value: (connector.energyImported / 1000).toFixed(3),
              measurand: "Energy.Active.Import.Register",
              unit: "kWh",
              context: "Sample.Periodic",
              location: "Outlet",
            },
            {
              value: connector.currentImport.toFixed(2),
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
            // L1 always present
            {
              value: voltageL1.toFixed(2),
              measurand: "Voltage",
              unit: "V",
              context: "Sample.Periodic",
              location: "Outlet",
              phase: "L1",
            },
            {
              value: currentL1.toFixed(2),
              measurand: "Current.Import",
              unit: "A",
              context: "Sample.Periodic",
              location: "Outlet",
              phase: "L1",
            },
          ];

          // L2/L3 only reported on 3-phase charger installations
          if (chargerPhases === 3) {
            sampledValue.push(
              {
                value: voltageL2.toFixed(2),
                measurand: "Voltage",
                unit: "V",
                context: "Sample.Periodic",
                location: "Outlet",
                phase: "L2",
              },
              {
                value: currentL2.toFixed(2),
                measurand: "Current.Import",
                unit: "A",
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
                value: currentL3.toFixed(2),
                measurand: "Current.Import",
                unit: "A",
                context: "Sample.Periodic",
                location: "Outlet",
                phase: "L3",
              }
            );
          }

          sampledValue.push({
            value: reportPower.toFixed(2),
            measurand: "Power.Active.Import",
            unit: "W",
            context: "Sample.Periodic",
            location: "Outlet",
          });

          // Add SoC measurand when car simulator is active
          if (socPercent !== undefined) {
            sampledValue.push({
              value: socPercent.toString(),
              measurand: "SoC",
              unit: "Percent",
              context: "Sample.Periodic",
              location: "EV",
            });
          }

          charger.vcp.send(
            meterValuesOcppMessage.request({
              connectorId: connector.connectorId,
              transactionId: connector.transactionId,
              meterValue: [
                {
                  timestamp: new Date().toISOString(),
                  sampledValue: sampledValue as any,
                },
              ],
            })
          );
        }
      }
    }, 15000);
  }

  private stopMeterValues(cpId: string) {
    const charger = this.chargers.get(cpId);
    if (charger?.meterInterval) {
      clearInterval(charger.meterInterval);
      charger.meterInterval = undefined;
    }
  }

  setConnectorStatus(
    cpId: string,
    connectorId: number,
    status: string,
    errorCode: string = "NoError"
  ): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    connector.status = status;
    connector.errorCode = errorCode;

    // If connected, send StatusNotification
    if (charger.vcp && charger.connected) {
      charger.vcp.send(
        statusNotificationOcppMessage.request({
          connectorId,
          errorCode,
          status,
        })
      );
    }

    return true;
  }

  setChargingCurrent(
    cpId: string,
    connectorId: number,
    currentAmps: number
  ): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    connector.currentImport = currentAmps;

    // Update power estimate (phases-aware, overwritten by next meter tick)
    const phases = connector.carSimulator?.getEffectivePhases() ?? (charger.config.phases || 3);
    connector.powerImport = 230 * currentAmps * phases;

    // Update car simulator's offered current if attached
    if (connector.carSimulator) {
      connector.carSimulator.setOfferedCurrent(currentAmps);
    }

    return true;
  }

  setTransactionId(
    cpId: string,
    connectorId: number,
    transactionId?: number
  ): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    connector.transactionId = transactionId;
    return true;
  }

  resetEnergy(cpId: string, connectorId: number): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    connector.energyImported = 0;
    return true;
  }

  sendChangeConfiguration(
    cpId: string,
    key: string,
    value: string
  ): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger?.vcp || !charger.connected) return false;

    // ChangeConfiguration is sent FROM the CSMS to the charger
    // The charger responds to it. But here we want to test the charger's response.
    // Actually, looking at OCPP 1.6, ChangeConfiguration is CSMS-initiated.
    // So we can't really "send" it from the charger side.
    //
    // What the user probably wants is to send a DataTransfer or similar,
    // or to execute admin commands.
    //
    // Let me check if there's a way to do this via the admin API...
    // Actually, looking at the VCP class, the admin API only has /execute
    // which sends outgoing messages from the charger.
    //
    // For testing purposes, let's send a DataTransfer with the config info
    // or we can use GetConfiguration to read current config.
    //
    // Actually, re-reading the requirement: "send ChangeConfigurations to adjust
    // their OCPP configuration parameters" - this doesn't make sense from
    // the charger's perspective. The charger RECEIVES ChangeConfiguration.
    //
    // I think what the user wants is to modify the internal config of the VCP
    // and/or send GetConfiguration requests to verify configuration.
    //
    // Let me implement this as modifying the VCP's internal config and
    // optionally triggering a response if the CSMS sends ChangeConfiguration.

    // For now, let's use DataTransfer to communicate config changes
    charger.vcp.send(
      call("DataTransfer", {
        vendorId: "VCPDashboard",
        messageId: "ConfigUpdate",
        data: JSON.stringify({ key, value }),
      })
    );

    return true;
  }

  // Bulk operations
  async bulkSetConnectorStatus(
    cpIds: string[],
    connectorId: number | "all",
    status: string,
    errorCode: string = "NoError"
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const cpId of cpIds) {
      const charger = this.chargers.get(cpId);
      if (!charger) {
        failed++;
        continue;
      }

      const connectorIds =
        connectorId === "all"
          ? charger.connectors.map((c) => c.connectorId)
          : [connectorId];

      for (const cId of connectorIds) {
        if (this.setConnectorStatus(cpId, cId, status, errorCode)) {
          success++;
        } else {
          failed++;
        }
      }
    }

    return { success, failed };
  }

  async bulkSetChargingCurrent(
    cpIds: string[],
    connectorId: number | "all",
    currentAmps: number
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const cpId of cpIds) {
      const charger = this.chargers.get(cpId);
      if (!charger) {
        failed++;
        continue;
      }

      const connectorIds =
        connectorId === "all"
          ? charger.connectors.map((c) => c.connectorId)
          : [connectorId];

      for (const cId of connectorIds) {
        if (this.setChargingCurrent(cpId, cId, currentAmps)) {
          success++;
        } else {
          failed++;
        }
      }
    }

    return { success, failed };
  }

  async bulkSendChangeConfiguration(
    cpIds: string[],
    key: string,
    value: string
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const cpId of cpIds) {
      if (this.sendChangeConfiguration(cpId, key, value)) {
        success++;
      } else {
        failed++;
      }
    }

    return { success, failed };
  }

  // Car simulator management
  plugInCar(
    cpId: string,
    connectorId: number,
    profileId: string,
    initialSoc: number = 0.2
  ): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    const profile = CAR_PROFILES.find((p) => p.id === profileId);
    if (!profile) return false;

    connector.carSimulator = new CarSimulator(
      profile,
      initialSoc,
      connector.currentImport,
      charger.config.phases
    );

    // If a transaction is already active (user started transaction first, then plugs in car),
    // transition through SuspendedEV → Charging
    if (connector.transactionId && connector.status === "Preparing") {
      this.transitionToCharging(cpId, connectorId);
    } else {
      // No transaction yet — just go to Preparing (cable plugged in)
      this.setConnectorStatus(cpId, connectorId, "Preparing");
    }

    return true;
  }

  unplugCar(cpId: string, connectorId: number): boolean {
    const charger = this.chargers.get(cpId);
    if (!charger) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    connector.carSimulator = undefined;

    // If transaction is active, go to Preparing (cable unplugged but transaction still open)
    // Otherwise go to Available
    if (connector.transactionId) {
      this.setConnectorStatus(cpId, connectorId, "Preparing");
    } else {
      this.setConnectorStatus(cpId, connectorId, "Available");
    }

    return true;
  }

  getCarStatus(
    cpId: string,
    connectorId: number
  ):
    | {
        pluggedIn: boolean;
        profileId?: string;
        profileName?: string;
        soc?: number;
        socPercent?: number;
        actualCurrentA?: number;
        energyDeliveredWh?: number;
        batteryCapacityKwh?: number;
        phases?: number;
      }
    | undefined {
    const charger = this.chargers.get(cpId);
    if (!charger) return undefined;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return undefined;

    if (!connector.carSimulator) {
      return { pluggedIn: false };
    }

    const sim = connector.carSimulator;
    const profile = sim.getProfile();
    return {
      pluggedIn: true,
      profileId: profile.id,
      profileName: profile.name,
      soc: sim.getSoc(),
      socPercent: sim.getSocPercent(),
      actualCurrentA: sim.getActualCurrentA(),
      energyDeliveredWh: sim.getEnergyDeliveredWh(),
      batteryCapacityKwh: profile.batteryCapacityKwh,
      phases: profile.phases,
    };
  }

  getCarProfiles(): CarProfile[] {
    return CAR_PROFILES;
  }

  // Transaction management
  async startTransaction(
    cpId: string,
    connectorId: number,
    idTag: string = "VIRTUAL001"
  ): Promise<boolean> {
    const charger = this.chargers.get(cpId);
    if (!charger?.vcp || !charger.connected) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return false;

    // Don't start if already in a transaction
    if (connector.transactionId) return false;

    // Send Authorize
    charger.vcp.send(
      authorizeOcppMessage.request({ idTag })
    );

    // Brief delay to let Authorize complete, then send StartTransaction
    await new Promise((r) => setTimeout(r, 500));

    charger.vcp.send(
      startTransactionOcppMessage.request({
        connectorId,
        idTag,
        meterStart: Math.round(connector.energyImported),
        timestamp: new Date().toISOString(),
      })
    );

    // Set to Preparing (waiting for EV or already has one)
    this.setConnectorStatus(cpId, connectorId, "Preparing");

    // Poll for transactionId from CSMS response (comes via VCP's resHandler → TransactionManager)
    let attempts = 0;
    const maxAttempts = 50; // 10 seconds max
    const pollInterval = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts || !charger.vcp) {
        clearInterval(pollInterval);
        console.log(`[TRANSACTION] ${cpId} conn ${connectorId}: timed out waiting for transactionId`);
        return;
      }
      const txns = charger.vcp.transactionManager.transactions;
      for (const [txId, tx] of txns) {
        if (tx.connectorId === connectorId) {
          clearInterval(pollInterval);
          connector.transactionId = txId as number;
          // Stop TransactionManager's own meter values timer (dashboard has its own)
          charger.vcp.transactionManager.stopTransaction(txId);
          console.log(`[TRANSACTION] ${cpId} conn ${connectorId}: transactionId=${txId}`);

          // If car is already plugged in, start the charging sequence
          if (connector.carSimulator) {
            this.transitionToCharging(cpId, connectorId);
          }
          return;
        }
      }
    }, 200);

    return true;
  }

  async stopTransaction(
    cpId: string,
    connectorId: number,
    reason: string = "Local"
  ): Promise<boolean> {
    const charger = this.chargers.get(cpId);
    if (!charger?.vcp || !charger.connected) return false;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector || !connector.transactionId) return false;

    // Send StopTransaction
    charger.vcp.send(
      stopTransactionOcppMessage.request({
        transactionId: connector.transactionId,
        meterStop: Math.round(connector.energyImported),
        timestamp: new Date().toISOString(),
        reason,
      })
    );

    console.log(`[TRANSACTION] ${cpId} conn ${connectorId}: stopped transactionId=${connector.transactionId}`);

    // Clear transaction state
    connector.transactionId = undefined;
    connector.powerImport = 0;

    // Set connector status based on whether car is still plugged in
    if (connector.carSimulator) {
      this.setConnectorStatus(cpId, connectorId, "Preparing");
    } else {
      this.setConnectorStatus(cpId, connectorId, "Available");
    }

    return true;
  }

  private transitionToCharging(cpId: string, connectorId: number) {
    const charger = this.chargers.get(cpId);
    if (!charger) return;

    const connector = charger.connectors.find(
      (c) => c.connectorId === connectorId
    );
    if (!connector) return;

    // Realistic: SuspendedEV first (EV initializing onboard charger)
    this.setConnectorStatus(cpId, connectorId, "SuspendedEV");

    // After 2-3 seconds, transition to Charging
    const delay = 2000 + Math.random() * 1000;
    setTimeout(() => {
      // Only transition if still SuspendedEV with an active transaction
      if (connector.status === "SuspendedEV" && connector.transactionId) {
        this.setConnectorStatus(cpId, connectorId, "Charging");
      }
    }, delay);
  }

  serializeConnector(cpId: string, connector: ConnectorState): any {
    const base: any = {
      connectorId: connector.connectorId,
      status: connector.status,
      errorCode: connector.errorCode,
      currentImport: connector.currentImport,
      powerImport: connector.powerImport,
      energyImported: connector.energyImported,
      transactionId: connector.transactionId,
    };

    if (connector.carSimulator) {
      const sim = connector.carSimulator;
      const profile = sim.getProfile();
      base.carSimulator = {
        pluggedIn: true,
        profileId: profile.id,
        profileName: profile.name,
        soc: sim.getSoc(),
        socPercent: sim.getSocPercent(),
        actualCurrentA: sim.getActualCurrentA(),
        energyDeliveredWh: sim.getEnergyDeliveredWh(),
        batteryCapacityKwh: profile.batteryCapacityKwh,
        phases: profile.phases,
        effectivePhases: sim.getEffectivePhases(),
      };
    }

    return base;
  }

  // Generate multiple chargers with auto-incrementing IDs
  generateChargers(
    prefix: string,
    count: number,
    baseConfig: Omit<ChargerConfig, "cpId" | "serialNumber">
  ): string[] {
    const created: string[] = [];

    for (let i = 1; i <= count; i++) {
      const cpId = `${prefix}-${i.toString().padStart(3, "0")}`;
      const config: ChargerConfig = {
        ...baseConfig,
        cpId,
        serialNumber: cpId,
      };

      if (this.addCharger(config)) {
        created.push(cpId);
      }
    }

    return created;
  }
}

// Singleton instance
export const chargerManager = new ChargerManager();
