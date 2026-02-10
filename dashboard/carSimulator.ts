export interface CarProfile {
  id: string;
  name: string;
  batteryCapacityKwh: number;
  maxAcCurrentA: number;
  onboardChargerKw: number;
  phases: 1 | 2 | 3;
  taperStartSoc: number; // e.g. 0.80 = 80%
  taperEndSoc: number; // e.g. 1.0 = 100%
  taperCurve: "linear" | "exponential";
}

export const CAR_PROFILES: CarProfile[] = [
  {
    id: "1p-16a",
    name: "EV Sim (1x16A, 25kWh)",
    batteryCapacityKwh: 25,
    maxAcCurrentA: 16,
    onboardChargerKw: 3.7,
    phases: 1,
    taperStartSoc: 0.85,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "1p-32a",
    name: "EV Sim (1x32A, 40kWh)",
    batteryCapacityKwh: 40,
    maxAcCurrentA: 32,
    onboardChargerKw: 7.4,
    phases: 1,
    taperStartSoc: 0.85,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "2p-16a",
    name: "EV Sim (2x16A, 50kWh)",
    batteryCapacityKwh: 50,
    maxAcCurrentA: 16,
    onboardChargerKw: 7.4,
    phases: 2,
    taperStartSoc: 0.82,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "2p-32a",
    name: "EV Sim (2x32A, 65kWh)",
    batteryCapacityKwh: 65,
    maxAcCurrentA: 32,
    onboardChargerKw: 14.7,
    phases: 2,
    taperStartSoc: 0.82,
    taperEndSoc: 1.0,
    taperCurve: "linear",
  },
  {
    id: "3p-16a",
    name: "EV Sim (3x16A, 75kWh)",
    batteryCapacityKwh: 75,
    maxAcCurrentA: 16,
    onboardChargerKw: 11.0,
    phases: 3,
    taperStartSoc: 0.80,
    taperEndSoc: 1.0,
    taperCurve: "exponential",
  },
  {
    id: "3p-32a",
    name: "EV Sim (3x32A, 100kWh)",
    batteryCapacityKwh: 100,
    maxAcCurrentA: 32,
    onboardChargerKw: 22.0,
    phases: 3,
    taperStartSoc: 0.80,
    taperEndSoc: 1.0,
    taperCurve: "exponential",
  },
];

export class CarSimulator {
  private profile: CarProfile;
  private effectivePhases: 1 | 2 | 3; // min(car phases, charger phases)
  private soc: number; // 0.0 to 1.0
  private offeredCurrentA: number;
  private actualCurrentA: number = 0;
  private energyDeliveredWh: number = 0;
  private margin: number; // random margin subtracted from offered current

  constructor(profile: CarProfile, initialSoc: number, offeredCurrentA: number, chargerPhases: 1 | 3 = 3) {
    this.profile = profile;
    this.effectivePhases = Math.min(profile.phases, chargerPhases) as 1 | 2 | 3;
    this.soc = Math.max(0, Math.min(0.99, initialSoc));
    this.offeredCurrentA = offeredCurrentA;
    // Random margin between 0.5 and 1.5A - car draws slightly below offered
    this.margin = 0.5 + Math.random();
  }

  getProfile(): CarProfile {
    return this.profile;
  }

  getEffectivePhases(): number {
    return this.effectivePhases;
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
    // P = phases * V_phase * I_per_phase => I = P / (phases * V)
    let carMaxCurrentA = (this.profile.onboardChargerKw * 1000) / (voltage * this.profile.phases);

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
    // P = effectivePhases * V_phase * I_per_phase
    const powerW = voltage * drawCurrent * this.effectivePhases;

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
