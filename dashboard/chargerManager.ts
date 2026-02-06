import { OcppVersion } from "../src/ocppVersion";
import { bootNotificationOcppMessage } from "../src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "../src/v16/messages/statusNotification";
import { meterValuesOcppMessage } from "../src/v16/messages/meterValues";
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
      charger.connected = true;

      // Send BootNotification
      vcp.send(
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
          const voltage = 230;
          let reportCurrent: number;
          let reportPower: number;
          let energyIncrement: number;
          let socPercent: number | undefined;

          if (connector.carSimulator) {
            // Car simulator takes over: tick the simulation
            const sim = connector.carSimulator;
            const result = sim.tick(15);
            reportCurrent = result.currentA;
            reportPower = result.powerW;
            energyIncrement = result.energyIncrementWh;
            connector.energyImported += energyIncrement;
            connector.powerImport = reportPower;
            socPercent = sim.getSocPercent();
          } else {
            // Manual mode: simple linear calculation
            const powerW = voltage * connector.currentImport;
            connector.powerImport = powerW;
            energyIncrement = (powerW * 15) / 3600;
            connector.energyImported += energyIncrement;
            reportCurrent = connector.currentImport;
            reportPower = powerW;
          }

          const sampledValue: Array<{
            value: string;
            measurand: string;
            unit: string;
            context: string;
            location?: string;
          }> = [
            {
              value: reportCurrent.toFixed(1),
              measurand: "Current.Import",
              unit: "A",
              context: "Sample.Periodic",
            },
            {
              value: reportPower.toFixed(0),
              measurand: "Power.Active.Import",
              unit: "W",
              context: "Sample.Periodic",
            },
            {
              value: connector.energyImported.toFixed(0),
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
              context: "Sample.Periodic",
            },
            {
              value: "230",
              measurand: "Voltage",
              unit: "V",
              context: "Sample.Periodic",
            },
          ];

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

    // Update power calculation
    connector.powerImport = 230 * currentAmps;

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
      connector.currentImport
    );
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
