export interface CarProfile {
  id: string;
  name: string;
  batteryCapacityKwh: number;
  maxAcCurrentA: number;
  onboardChargerKw: number;
  phases: 1 | 3;
  taperStartSoc: number; // e.g. 0.80 = 80%
  taperEndSoc: number; // e.g. 1.0 = 100%
  taperCurve: "linear" | "exponential";
}

export const CAR_PROFILES: CarProfile[] = [
  {
    id: "generic-small",
    name: "Generic Small EV",
    batteryCapacityKwh: 24,
    maxAcCurrentA: 16,
    onboardChargerKw: 3.7,
    phases: 1,
    taperStartSoc: 0.85,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "generic-medium",
    name: "Generic Medium EV",
    batteryCapacityKwh: 60,
    maxAcCurrentA: 32,
    onboardChargerKw: 7.4,
    phases: 1,
    taperStartSoc: 0.80,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "generic-large",
    name: "Generic Large EV",
    batteryCapacityKwh: 75,
    maxAcCurrentA: 16,
    onboardChargerKw: 11,
    phases: 3,
    taperStartSoc: 0.85,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "tesla-model-3",
    name: "Tesla Model 3",
    batteryCapacityKwh: 57.5,
    maxAcCurrentA: 16,
    onboardChargerKw: 11,
    phases: 3,
    taperStartSoc: 0.80,
    taperEndSoc: 1.0,
    taperCurve: "exponential",
  },
  {
    id: "nissan-leaf",
    name: "Nissan Leaf",
    batteryCapacityKwh: 40,
    maxAcCurrentA: 32,
    onboardChargerKw: 6.6,
    phases: 1,
    taperStartSoc: 0.85,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "vw-id3",
    name: "VW ID.3",
    batteryCapacityKwh: 58,
    maxAcCurrentA: 16,
    onboardChargerKw: 11,
    phases: 3,
    taperStartSoc: 0.82,
    taperEndSoc: 1.0,
    taperCurve: "exponential",
  },
];

export class CarSimulator {
  private profile: CarProfile;
  private soc: number; // 0.0 to 1.0
  private offeredCurrentA: number;
  private actualCurrentA: number = 0;
  private energyDeliveredWh: number = 0;
  private margin: number; // random margin subtracted from offered current

  constructor(profile: CarProfile, initialSoc: number, offeredCurrentA: number) {
    this.profile = profile;
    this.soc = Math.max(0, Math.min(0.99, initialSoc));
    this.offeredCurrentA = offeredCurrentA;
    // Random margin between 0.5 and 1.5A - car draws slightly below offered
    this.margin = 0.5 + Math.random();
  }

  getProfile(): CarProfile {
    return this.profile;
  }

  getSoc(): number {
    return this.soc;
  }

  getSocPercent(): number {
    return Math.round(this.soc * 100);
  }

  getActualCurrentA(): number {
    return this.actualCurrentA;
  }

  getEnergyDeliveredWh(): number {
    return this.energyDeliveredWh;
  }

  setOfferedCurrent(currentA: number) {
    this.offeredCurrentA = currentA;
  }

  /**
   * Advance simulation by intervalSeconds.
   * Returns the actual current draw for this tick.
   */
  tick(intervalSeconds: number): {
    currentA: number;
    powerW: number;
    energyIncrementWh: number;
    soc: number;
  } {
    // At or above 100% SoC, stop drawing
    if (this.soc >= 1.0) {
      this.actualCurrentA = 0;
      return { currentA: 0, powerW: 0, energyIncrementWh: 0, soc: this.soc };
    }

    const voltage = 230;

    // 1. Compute car's max acceptance current from onboard charger
    let carMaxCurrentA: number;
    if (this.profile.phases === 3) {
      // P = V * I * sqrt(3) => I = P / (V * sqrt(3))
      carMaxCurrentA = (this.profile.onboardChargerKw * 1000) / (voltage * Math.sqrt(3));
    } else {
      // P = V * I => I = P / V
      carMaxCurrentA = (this.profile.onboardChargerKw * 1000) / voltage;
    }

    // Also clamp to car's physical max AC current
    carMaxCurrentA = Math.min(carMaxCurrentA, this.profile.maxAcCurrentA);

    // 2. Apply SoC-based tapering
    let taperFactor = 1.0;
    if (this.soc >= this.profile.taperStartSoc) {
      const taperProgress =
        (this.soc - this.profile.taperStartSoc) /
        (this.profile.taperEndSoc - this.profile.taperStartSoc);
      const clampedProgress = Math.min(1.0, Math.max(0, taperProgress));

      if (this.profile.taperCurve === "exponential") {
        // Exponential decay: current drops faster as SoC increases
        taperFactor = Math.exp(-3 * clampedProgress);
      } else {
        // Linear decay
        taperFactor = 1.0 - clampedProgress;
      }
      // Ensure minimum taper factor so current doesn't go to exactly 0 before 100%
      taperFactor = Math.max(0.05, taperFactor);
    }

    const taperedCarCurrent = carMaxCurrentA * taperFactor;

    // 3. Subtract margin from EVSE offered current (cars draw below offered)
    const offeredWithMargin = Math.max(0, this.offeredCurrentA - this.margin);

    // 4. Take minimum of car's capability vs offered-with-margin
    let drawCurrent = Math.min(taperedCarCurrent, offeredWithMargin);

    // 5. Add small jitter (+/- 0.2A) for measurement realism
    const jitter = (Math.random() - 0.5) * 0.4; // -0.2 to +0.2
    drawCurrent = Math.max(0, drawCurrent + jitter);

    // Round to 1 decimal
    drawCurrent = Math.round(drawCurrent * 10) / 10;

    this.actualCurrentA = drawCurrent;

    // 6. Calculate energy delivered and update SoC
    let powerW: number;
    if (this.profile.phases === 3) {
      powerW = voltage * drawCurrent * Math.sqrt(3);
    } else {
      powerW = voltage * drawCurrent;
    }

    const energyIncrementWh = (powerW * intervalSeconds) / 3600;
    this.energyDeliveredWh += energyIncrementWh;

    // Update SoC
    const batteryCapacityWh = this.profile.batteryCapacityKwh * 1000;
    this.soc += energyIncrementWh / batteryCapacityWh;

    // 7. Clamp SoC to 100%
    if (this.soc >= 1.0) {
      this.soc = 1.0;
      this.actualCurrentA = 0;
    }

    return {
      currentA: this.actualCurrentA,
      powerW: Math.round(powerW),
      energyIncrementWh,
      soc: this.soc,
    };
  }
}
