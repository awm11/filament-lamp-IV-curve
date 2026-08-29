import { useEffect, useRef, useState } from "react";
import negativeCircuitDiagram from "./assets/circuit-diagram (negative).svg";
import positiveCircuitDiagram from "./assets/circuit-diagram (positive).svg";
import uprightBulb from "./assets/upright-filament-bulb.svg";

// The canvas is a single responsive stage. Its CSS size may change, but these
// internal coordinates stay fixed so every drawn element scales together.
const WIDTH = 1600;
const HEIGHT = 920;
const CANVAS_RENDER_SCALE = 2;

// The particle apparatus is rendered as one uniformly-scaled object. Physics
// coordinates and the relative dimensions of reservoir / filament / sink / ions
// remain unchanged.
const PARTICLE_VIEW_SCALE = 0.96;
const PARTICLE_VIEW_OFFSET_X = 240;
const PARTICLE_VIEW_OFFSET_Y = -103;

// Shared analysis-column geometry. Keeping these in one place prevents the
// I-V and time-series panels drifting to unrelated widths and margins.
const ANALYSIS_X = 920;
const ANALYSIS_WIDTH = 650; // shared width for I-V, current history, and instrument panel
const IV_PANEL_WIDTH = ANALYSIS_WIDTH; // all analysis panels now share the same width
const IV_PANEL_Y = 29;
const IV_PANEL_HEIGHT = 491;
const IV_PANEL_COLLAPSED_HEIGHT = 42;
const HISTORY_PANEL_HEIGHT = 170;
const HISTORY_PANEL_COLLAPSED_HEIGHT = 42;
const INSTRUMENT_PANEL_HEIGHT = 174;
const ANALYSIS_PANEL_GAP = 16;

const ivPanelRenderedHeight = (minimised) =>
  minimised ? IV_PANEL_COLLAPSED_HEIGHT : IV_PANEL_HEIGHT;
const historyPanelTop = (ivGraphMinimised) =>
  IV_PANEL_Y + ivPanelRenderedHeight(ivGraphMinimised) + ANALYSIS_PANEL_GAP;
const historyPanelRenderedHeight = (minimised) =>
  minimised ? HISTORY_PANEL_COLLAPSED_HEIGHT : HISTORY_PANEL_HEIGHT;
const instrumentPanelTop = (ivGraphMinimised, currentHistoryMinimised) =>
  historyPanelTop(ivGraphMinimised) +
  historyPanelRenderedHeight(currentHistoryMinimised) +
  ANALYSIS_PANEL_GAP;

const AMBIENT_TEMP = 20;
const DEFAULT_VOLTAGE = 2;
const BULB_GLOW_START_TEMP = 400;
const BULB_GLOW_FULL_TEMP = 1600;
const MAX_VOLTAGE = 12;
const MAX_RESERVOIR_ELECTRONS = 1382; // 96% of 1440 to preserve density in 0.96x chamber area
const MAX_TOTAL_ELECTRONS = 2700;
const SIMPLIFIED_PARTICLE_DIVISOR = 10;
const SIMPLIFIED_MAX_TOTAL_ELECTRONS = Math.ceil(
  MAX_TOTAL_ELECTRONS / SIMPLIFIED_PARTICLE_DIVISOR
);

const ELECTRON_RADIUS = 3.2;
const WALL_BUFFER = ELECTRON_RADIUS + 2.5;
const SPAWN_SPEED_MIN = 55;
const SPAWN_SPEED_MAX = 85;

// Exact all-to-all, softened electron repulsion.
const REPULSION_K = 22000;
const REPULSION_SOFTENING = 11;
const OVERLAP_PUSH = 55;

// Electron-ion collision / heating model.
const ION_RADIUS = 10.5; // nominal radius; drawing applies a separate visual scale
const MAX_ION_COLLISION_RADIUS = 30.0; // larger maximum invisible effective radius
const ION_COLLISION_GROWTH_START_CURRENT = 2.5;
const ION_COLLISION_FULL_SCALE_CURRENT = 5.0;
const COLLISION_RESTITUTION = 0.91;
const COLLISION_SCATTER = 0.42;
// Hotter lattice vibrations randomise electron direction more strongly.
// Keep the effect bounded so higher p.d. still produces greater current,
// but with a progressively smaller increase as the filament heats.
const MAX_COLLISION_SCATTER = 1.8;
const SCATTER_FULL_SCALE_TEMP = 2000;
const COLLISION_HEAT_SCALE = 0.000275;

// Passive cooling toward the fixed 20 C ambient temperature.
const COOLING_RATE = 0.48;

// With roughly twice as many representative electrons, each electron carries
// roughly half the display weight used by the previous version.
const CURRENT_SCALE = 0.03;

// Current is the signed electron crossing rate averaged over the previous 5 s.
// The same rolling-average current drives the readout, time series, resistance,
// and captured I-V data points.
const CURRENT_AVERAGE_WINDOW_MS = 5000;
const COLLISION_DIAGNOSTIC_WINDOW_MS = 5000;
const AMMETER_HISTORY_MS = 20000;
const AMMETER_HISTORY_SAMPLE_MS = 500;
const AMMETER_HISTORY_EDGE_BUFFER_MS = AMMETER_HISTORY_SAMPLE_MS * 2;
const SIMPLIFIED_CURRENT_TRANSITION_MS = 1500;
const SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS = 500;
const SIMPLIFIED_CURRENT_VARIATION_SD = 0.035;
const SIMPLIFIED_CURRENT_VARIATION_LIMIT = 0.1;
const SIMPLIFIED_FIELD_ACCELERATION_PER_AMP = 100;
const SIMPLIFIED_MAX_ELECTRON_SPEED = 260;
const SIMPLIFIED_COLLISION_RESTITUTION = 1;
const SIMPLIFIED_COLLISION_SPEED_RETENTION = 0.6;
const SIMPLIFIED_TRAIL_SAMPLE_INTERVAL = 0.0175;
const SIMPLIFIED_TRAIL_POSITION_COUNT = 12;
const SIMPLIFIED_NOOK_HOLD_SECONDS = 1;

const RESERVOIR = {
  // Narrower and taller than the earlier baseline while keeping the
  // filament-side edge fixed and the chamber vertically centred.
  x: 29,
  y: 144,
  width: 265,
  height: 887,
};

const FILAMENT = {
  x: 272,
  // Four ion columns spaced even farther apart horizontally.
  // Extending the filament width by about one third gives a 272 px usable span
  // between the 30 px edge margins, so the 4 columns sit about 90.7 px apart.
  y: 234,
  width: 332,
  height: 708,
};

const MICROSCOPIC_FRAME_RENDER = {
  x: (FILAMENT.x - 12) * PARTICLE_VIEW_SCALE + PARTICLE_VIEW_OFFSET_X,
  y: (FILAMENT.y - 46) * PARTICLE_VIEW_SCALE + PARTICLE_VIEW_OFFSET_Y,
  width: (FILAMENT.width + 24) * PARTICLE_VIEW_SCALE,
  height: (FILAMENT.height + 64) * PARTICLE_VIEW_SCALE,
};

const MACRO_VIEW_OFFSET_X = -10;
const MACRO_VIEW_OFFSET_Y = 30;
const ZOOM_SOURCE = {
  x: 285 + MACRO_VIEW_OFFSET_X,
  y: 306 + MACRO_VIEW_OFFSET_Y,
};
const ZOOM_TARGET_OVERLAP = 20;
const ZOOM_TARGET_TOP_INSET = 50;
const ZOOM_TARGET_BOTTOM_INSET = 40;

const SINK = {
  // Match the reshaped source reservoir. Keeping the same filament-side anchor
  // means the extra width extends outward rather than deeper into the filament.
  x: FILAMENT.x + FILAMENT.width - 6,
  y: RESERVOIR.y,
  width: RESERVOIR.width,
  height: RESERVOIR.height,
};

// Explicit neck regions make the visual joins and the collision geometry agree.
// They overlap both neighbouring regions by more than WALL_BUFFER, so there is
// never an invisible buffered wall between the chambers.
const SOURCE_NECK = {
  x: FILAMENT.x - 16,
  // Tall opening centred on the 12-row filament.
  y: FILAMENT.y + 14,
  width: 32,
  height: FILAMENT.height - 28,
};

const SINK_NECK = {
  x: FILAMENT.x + FILAMENT.width - 18,
  y: FILAMENT.y + 14,
  width: 42,
  height: FILAMENT.height - 28,
};

const LEFT_EXIT_X = RESERVOIR.x + 5;
const RIGHT_EXIT_X = SINK.x + SINK.width - 5;
const AMMETER_X = Math.round(FILAMENT.x + FILAMENT.width * 0.74);

class Electron {
  constructor(x, y) {
    const angle = Math.random() * Math.PI * 2;
    const speed =
      SPAWN_SPEED_MIN + Math.random() * (SPAWN_SPEED_MAX - SPAWN_SPEED_MIN);

    this.x = x;
    this.y = y;
    this.oldX = x;
    this.oldY = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.radius = ELECTRON_RADIUS;
    // Once an electron has moved well inside the active sink, it becomes
    // committed to that sink. It can still move and repel other electrons
    // inside the chamber, but it cannot cross back through the neck.
    this.sinkCommittedDirection = 0;
  }
}

function pointInRect(x, y, rect, inset = 0) {
  return (
    x >= rect.x + inset &&
    x <= rect.x + rect.width - inset &&
    y >= rect.y + inset &&
    y <= rect.y + rect.height - inset
  );
}

function pointInRoundedRect(x, y, rect, radius, inset = 0) {
  const left = rect.x + inset;
  const right = rect.x + rect.width - inset;
  const top = rect.y + inset;
  const bottom = rect.y + rect.height - inset;

  if (x < left || x > right || y < top || y > bottom) return false;

  // Eroding a rounded rectangle by `inset` reduces the usable corner radius by
  // the same amount. This keeps an electron centre a full wall-buffer distance
  // inside the visibly rounded filament edge.
  const innerRadius = Math.max(
    0,
    Math.min(radius - inset, (right - left) / 2, (bottom - top) / 2)
  );

  if (innerRadius <= 0) return true;

  const innerLeft = left + innerRadius;
  const innerRight = right - innerRadius;
  const innerTop = top + innerRadius;
  const innerBottom = bottom - innerRadius;

  if (x >= innerLeft && x <= innerRight) return true;
  if (y >= innerTop && y <= innerBottom) return true;

  const cornerX = x < innerLeft ? innerLeft : innerRight;
  const cornerY = y < innerTop ? innerTop : innerBottom;
  const dx = x - cornerX;
  const dy = y - cornerY;

  return dx * dx + dy * dy <= innerRadius * innerRadius;
}

function neckGateContainsY(neck, y) {
  return (
    y >= neck.y + WALL_BUFFER &&
    y <= neck.y + neck.height - WALL_BUFFER
  );
}

function movementCrossesClosedTerminalWall(x1, y1, x2, y2) {
  // moveElectron advances one axis at a time, so this guard is concerned with
  // the horizontal terminal/filament interface. Outside the neck opening there
  // is now a full WALL_BUFFER-thick barrier on both sides of the filament.
  if (y1 !== y2) return false;

  const moveLeft = Math.min(x1, x2);
  const moveRight = Math.max(x1, x2);

  const leftBarrierLeft = FILAMENT.x - WALL_BUFFER;
  const leftBarrierRight = FILAMENT.x + WALL_BUFFER;
  if (
    !neckGateContainsY(SOURCE_NECK, y1) &&
    moveRight >= leftBarrierLeft &&
    moveLeft <= leftBarrierRight
  ) {
    return true;
  }

  const filamentRight = FILAMENT.x + FILAMENT.width;
  const rightBarrierLeft = filamentRight - WALL_BUFFER;
  const rightBarrierRight = filamentRight + WALL_BUFFER;
  if (
    !neckGateContainsY(SINK_NECK, y1) &&
    moveRight >= rightBarrierLeft &&
    moveLeft <= rightBarrierRight
  ) {
    return true;
  }

  return false;
}

function insideAllowedRegion(x, y) {
  const inLeftNeck = pointInRect(x, y, SOURCE_NECK, WALL_BUFFER);
  const inRightNeck = pointInRect(x, y, SINK_NECK, WALL_BUFFER);
  const inFilament = pointInRoundedRect(
    x,
    y,
    FILAMENT,
    18,
    WALL_BUFFER
  );

  // Keep the closed wall where each terminal overlaps the filament vertically,
  // but allow electrons to occupy the full terminal corners above and below it.
  const outsideFilamentVerticalSpan =
    y < FILAMENT.y - WALL_BUFFER ||
    y > FILAMENT.y + FILAMENT.height + WALL_BUFFER;
  const inLeftTerminal =
    pointInRect(x, y, RESERVOIR, WALL_BUFFER) &&
    (
      outsideFilamentVerticalSpan ||
      x <= FILAMENT.x - WALL_BUFFER ||
      neckGateContainsY(SOURCE_NECK, y)
    );

  const filamentRight = FILAMENT.x + FILAMENT.width;
  const inRightTerminal =
    pointInRect(x, y, SINK, WALL_BUFFER) &&
    (
      outsideFilamentVerticalSpan ||
      x >= filamentRight + WALL_BUFFER ||
      neckGateContainsY(SINK_NECK, y)
    );

  return (
    inLeftTerminal ||
    inLeftNeck ||
    inFilament ||
    inRightNeck ||
    inRightTerminal
  );
}

function inConductor(electron) {
  return pointInRoundedRect(electron.x, electron.y, FILAMENT, 18, 0);
}

function flowDirection(potentialDifference) {
  // Keep the particle source intuitive relative to the slider: positive p.d.
  // feeds electrons from the right, while negative p.d. feeds them from the left.
  return potentialDifference < 0 ? 1 : -1;
}

function sourceRectFor(potentialDifference) {
  return flowDirection(potentialDifference) > 0 ? RESERVOIR : SINK;
}

function sinkRectFor(potentialDifference) {
  return flowDirection(potentialDifference) > 0 ? SINK : RESERVOIR;
}

function inSourceReservoir(electron, potentialDifference) {
  const sourceRect = sourceRectFor(potentialDifference);
  // The chambers overlap the connector mouths slightly. Once an electron has
  // reached the filament, treat it as conductor-side so a slider change never
  // deletes an electron already in the wire.
  return (
    pointInRect(electron.x, electron.y, sourceRect, WALL_BUFFER) &&
    !inConductor(electron)
  );
}

function voltageToTargetCount(voltage, simplifiedMotion = false) {
  // Electron density represents the magnitude of the potential difference.
  // The sign selects which side acts as the source reservoir.
  const fullTarget = Math.round(
    Math.sqrt(Math.abs(voltage) / MAX_VOLTAGE) * MAX_RESERVOIR_ELECTRONS
  );
  return simplifiedMotion
    ? Math.round(fullTarget / SIMPLIFIED_PARTICLE_DIVISOR)
    : fullTarget;
}

function makeIonLattice() {
  const ions = [];
  const startX = FILAMENT.x + 30;
  const endX = FILAMENT.x + FILAMENT.width - 30;

  // Reduce the lattice further from 16 rows to 12 rows, spreading the rows
  // farther apart so the lattice still fills the filament height.
  const edgeInset = 14;
  const rowCount = 12;

  // Allow alternate columns to be staggered vertically by half a row while
  // still keeping every ion inside the filament.
  const rowSpacing = (FILAMENT.height - edgeInset * 2) / (rowCount - 0.5);

  // Four columns with ~50% more horizontal spacing than the previous layout.
  const columnCount = 4;
  const columnXs = Array.from(
    { length: columnCount },
    (_, column) =>
      startX + (column * (endX - startX)) / Math.max(1, columnCount - 1)
  );

  let index = 0;
  for (let column = 0; column < columnXs.length; column += 1) {
    const restX = columnXs[column];
    const staggerY = column % 2 === 1 ? rowSpacing * 0.5 : 0;

    for (let row = 0; row < rowCount; row += 1) {
      const restY = FILAMENT.y + edgeInset + row * rowSpacing + staggerY;

      ions.push({
        restX,
        restY,
        x: restX,
        y: restY,
        phaseX: Math.random() * Math.PI * 2,
        phaseY: Math.random() * Math.PI * 2,
        freqX: 5.2 + Math.random() * 2.8,
        freqY: 4.7 + Math.random() * 3.1,
        radius: ION_RADIUS,
        index: index++,
      });
    }
  }

  return ions;
}

function ionVibrationAmplitude(tempC) {
  const excess = Math.max(0, tempC - AMBIENT_TEMP);

  // Visual-only vibration. Keep the shake readable at high temperature without
  // affecting the larger invisible collision radius used by the physics.
  return 0.35 + Math.min(4.0, Math.sqrt(excess) * 0.10);
}

function temperatureHeatLevel(tempC) {
  return Math.min(
    1,
    Math.max(0, (tempC - AMBIENT_TEMP) / (2000 - AMBIENT_TEMP))
  );
}

function bulbGlowHeatLevel(tempC) {
  return Math.min(
    1,
    Math.max(
      0,
      (tempC - BULB_GLOW_START_TEMP) /
        (BULB_GLOW_FULL_TEMP - BULB_GLOW_START_TEMP)
    )
  );
}

function updateIons(ions, tempC, timeSeconds) {
  const amplitude = ionVibrationAmplitude(tempC);

  for (const ion of ions) {
    ion.x =
      ion.restX + Math.sin(timeSeconds * ion.freqX + ion.phaseX) * amplitude;
    ion.y =
      ion.restY + Math.sin(timeSeconds * ion.freqY + ion.phaseY) * amplitude;
  }
}

function makeElectronSpacingIndex(electrons, cellSize = 12) {
  const buckets = new Map();
  const keyFor = (cellX, cellY) => `${cellX}:${cellY}`;

  const add = (electron) => {
    const cellX = Math.floor(electron.x / cellSize);
    const cellY = Math.floor(electron.y / cellSize);
    const key = keyFor(cellX, cellY);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(electron);
    } else {
      buckets.set(key, [electron]);
    }
  };

  const isClear = (x, y, minimumSpacing = 11) => {
    const centreCellX = Math.floor(x / cellSize);
    const centreCellY = Math.floor(y / cellSize);
    const cellReach = Math.ceil(minimumSpacing / cellSize);
    const minimumSpacing2 = minimumSpacing * minimumSpacing;

    for (let offsetY = -cellReach; offsetY <= cellReach; offsetY += 1) {
      for (let offsetX = -cellReach; offsetX <= cellReach; offsetX += 1) {
        const bucket = buckets.get(
          keyFor(centreCellX + offsetX, centreCellY + offsetY)
        );
        if (!bucket) continue;

        for (const other of bucket) {
          const dx = other.x - x;
          const dy = other.y - y;
          if (dx * dx + dy * dy < minimumSpacing2) return false;
        }
      }
    }
    return true;
  };

  for (const electron of electrons) add(electron);
  return { add, isClear };
}

function spawnOneElectron(
  electrons,
  potentialDifference,
  spacingIndex = makeElectronSpacingIndex(electrons)
) {
  const sourceRect = sourceRectFor(potentialDifference);

  const left = sourceRect.x + WALL_BUFFER + 5;
  const right = sourceRect.x + sourceRect.width - WALL_BUFFER - 5;
  const top = sourceRect.y + WALL_BUFFER + 5;
  const bottom = sourceRect.y + sourceRect.height - WALL_BUFFER - 5;

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const x = left + Math.random() * Math.max(1, right - left);
    const y = top + Math.random() * Math.max(1, bottom - top);

    if (!insideAllowedRegion(x, y)) continue;
    if (!spacingIndex.isClear(x, y)) continue;

    const electron = new Electron(x, y);
    electrons.push(electron);
    spacingIndex.add(electron);
    return true;
  }

  return false;
}

function rebuildReservoirPopulation(
  electrons,
  targetCount,
  potentialDifference,
  maxTotalElectrons = MAX_TOTAL_ELECTRONS
) {
  const sourceRect = sourceRectFor(potentialDifference);

  // Keep conductor electrons and anything outside the current source chamber,
  // but replace the complete source-reservoir population on every slider change.
  const retained = electrons.filter(
    (electron) => !inSourceReservoir(electron, potentialDifference)
  );
  const spacingIndex = makeElectronSpacingIndex(retained);

  const candidates = [];
  const spacing = 11.4;
  const top = sourceRect.y + WALL_BUFFER + 7;
  const bottom = sourceRect.y + sourceRect.height - WALL_BUFFER - 7;
  const left = sourceRect.x + WALL_BUFFER + 7;
  const right = sourceRect.x + sourceRect.width - WALL_BUFFER - 7;

  for (let y = top; y <= bottom; y += spacing) {
    for (let x = left; x <= right; x += spacing) {
      candidates.push({
        x: x + (Math.random() - 0.5) * 3.0,
        y: y + (Math.random() - 0.5) * 3.0,
      });
    }
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const desired = Math.min(
    targetCount,
    Math.max(0, maxTotalElectrons - retained.length)
  );
  let added = 0;

  for (const point of candidates) {
    if (added >= desired) break;
    if (!insideAllowedRegion(point.x, point.y)) continue;
    if (!spacingIndex.isClear(point.x, point.y, 9.4)) continue;
    const electron = new Electron(point.x, point.y);
    retained.push(electron);
    spacingIndex.add(electron);
    added += 1;
  }

  let attempts = 0;
  while (added < desired && attempts < desired * 120) {
    attempts += 1;
    const x = left + Math.random() * Math.max(1, right - left);
    const y = top + Math.random() * Math.max(1, bottom - top);
    if (!insideAllowedRegion(x, y)) continue;
    if (!spacingIndex.isClear(x, y, 9.2)) continue;
    const electron = new Electron(x, y);
    retained.push(electron);
    spacingIndex.add(electron);
    added += 1;
  }

  return retained;
}

function conductorTargetCountFromReservoir(targetCount) {
  // Density = count / usable area. At startup the conductor is seeded at
  // exactly half the source-reservoir density, so account for the two regions
  // having different usable areas rather than simply halving the count.
  const reservoirUsableWidth =
    FILAMENT.x - WALL_BUFFER - (RESERVOIR.x + WALL_BUFFER);
  const reservoirUsableHeight = RESERVOIR.height - WALL_BUFFER * 2;
  const conductorUsableWidth = FILAMENT.width - WALL_BUFFER * 2;
  const conductorUsableHeight = FILAMENT.height - WALL_BUFFER * 2;

  const reservoirArea = Math.max(1, reservoirUsableWidth * reservoirUsableHeight);
  const conductorArea = Math.max(1, conductorUsableWidth * conductorUsableHeight);

  return Math.round(targetCount * 0.5 * (conductorArea / reservoirArea));
}

function seedConductorPopulation(
  electrons,
  ions,
  targetCount,
  maxTotalElectrons = MAX_TOTAL_ELECTRONS
) {
  const seeded = [...electrons];
  const spacingIndex = makeElectronSpacingIndex(seeded);
  const candidates = [];
  const spacing = 11.6;
  const left = FILAMENT.x + WALL_BUFFER + 3;
  const right = FILAMENT.x + FILAMENT.width - WALL_BUFFER - 7;
  const top = FILAMENT.y + WALL_BUFFER + 3;
  const bottom = FILAMENT.y + FILAMENT.height - WALL_BUFFER - 3;

  // A jittered grid gives an even-looking pseudo-random starting density.
  for (let y = top; y <= bottom; y += spacing) {
    for (let x = left; x <= right; x += spacing) {
      candidates.push({
        x: x + (Math.random() - 0.5) * 3.2,
        y: y + (Math.random() - 0.5) * 3.2,
      });
    }
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const desired = Math.min(
    targetCount,
    Math.max(0, maxTotalElectrons - seeded.length)
  );
  let added = 0;

  for (const point of candidates) {
    if (added >= desired) break;
    if (!pointInRoundedRect(point.x, point.y, FILAMENT, 18, WALL_BUFFER)) {
      continue;
    }
    if (!spacingIndex.isClear(point.x, point.y, 9.2)) continue;

    let clearOfIons = true;
    for (const ion of ions) {
      const dx = point.x - ion.x;
      const dy = point.y - ion.y;
      const minimum = ion.radius + ELECTRON_RADIUS + 1.2;
      if (dx * dx + dy * dy < minimum * minimum) {
        clearOfIons = false;
        break;
      }
    }
    if (!clearOfIons) continue;

    const electron = new Electron(point.x, point.y);
    seeded.push(electron);
    spacingIndex.add(electron);
    added += 1;
  }

  return seeded;
}

function makeInitialElectronPopulation(voltage, ions, simplifiedMotion = false) {
  const reservoirTarget = voltageToTargetCount(voltage, simplifiedMotion);
  const maxTotalElectrons = simplifiedMotion
    ? SIMPLIFIED_MAX_TOTAL_ELECTRONS
    : MAX_TOTAL_ELECTRONS;
  let electrons = rebuildReservoirPopulation(
    [],
    reservoirTarget,
    voltage,
    maxTotalElectrons
  );
  const conductorTarget = conductorTargetCountFromReservoir(reservoirTarget);
  electrons = seedConductorPopulation(
    electrons,
    ions,
    conductorTarget,
    maxTotalElectrons
  );
  return electrons;
}

function maintainReservoirPopulation(
  electrons,
  targetCount,
  potentialDifference,
  maxTotalElectrons = MAX_TOTAL_ELECTRONS
) {
  if (electrons.length >= maxTotalElectrons) return;

  let currentCount = 0;
  for (const electron of electrons) {
    if (inSourceReservoir(electron, potentialDifference)) currentCount += 1;
  }

  const missing = Math.min(
    targetCount - currentCount,
    maxTotalElectrons - electrons.length
  );

  if (missing <= 0) return;

  // After the slider-triggered rebuild, replace electrons that flow out by
  // spawning fresh ones throughout the source reservoir body so the selected
  // density can be maintained even when the outer edge is crowded.
  const toSpawn = Math.min(missing, 30);
  const spacingIndex = makeElectronSpacingIndex(electrons);
  for (let i = 0; i < toSpawn; i += 1) {
    if (!spawnOneElectron(electrons, potentialDifference, spacingIndex)) break;
  }
}

function repelElectronPair(a, b, dt, soft2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const r2 = dx * dx + dy * dy;

  if (r2 < 0.0001) return;

  const distance = Math.sqrt(r2);
  const nx = dx / distance;
  const ny = dy / distance;
  const acceleration = REPULSION_K / (r2 + soft2);

  const dv = acceleration * dt;
  a.vx -= nx * dv;
  a.vy -= ny * dv;
  b.vx += nx * dv;
  b.vy += ny * dv;

  const minimum = a.radius + b.radius;
  if (distance < minimum) {
    const overlap = minimum - distance;
    const impulse = overlap * OVERLAP_PUSH * dt;
    a.vx -= nx * impulse;
    a.vy -= ny * impulse;
    b.vx += nx * impulse;
    b.vy += ny * impulse;

    // Positional separation prevents a pair from remaining numerically glued.
    const correction = overlap * 0.28;
    a.x -= nx * correction;
    a.y -= ny * correction;
    b.x += nx * correction;
    b.y += ny * correction;
  }
}

function repelElectrons(electrons, dt) {
  const soft2 = REPULSION_SOFTENING * REPULSION_SOFTENING;

  for (let i = 0; i < electrons.length; i += 1) {
    for (let j = i + 1; j < electrons.length; j += 1) {
      repelElectronPair(electrons[i], electrons[j], dt, soft2);
    }
  }
}

function maybeCommitElectronToSink(electron, potentialDifference) {
  if (electron.sinkCommittedDirection !== 0) return;

  const direction = flowDirection(potentialDifference);
  const sinkRect = sinkRectFor(potentialDifference);

  // Do not commit an electron merely because it brushes the connector mouth.
  // Require it to travel a short distance into the sink body first.
  const commitmentDepth = 28;
  const insideSinkVertically =
    electron.y >= sinkRect.y + WALL_BUFFER &&
    electron.y <= sinkRect.y + sinkRect.height - WALL_BUFFER;

  if (!insideSinkVertically) return;

  const deepEnough =
    direction > 0
      ? electron.x >= sinkRect.x + commitmentDepth
      : electron.x <= sinkRect.x + sinkRect.width - commitmentDepth;

  if (deepEnough) {
    electron.sinkCommittedDirection = direction;
  }
}

function moveCommittedSinkElectron(electron, dt, potentialDifference) {
  const direction = electron.sinkCommittedDirection;
  const sinkRect = sinkRectFor(potentialDifference);

  // A polarity change clears external chambers before the next frame, so a
  // committed electron should normally always agree with the active sink.
  // If one somehow survives a transition, release it to the ordinary solver.
  if (direction !== flowDirection(potentialDifference)) {
    electron.sinkCommittedDirection = 0;
    return false;
  }

  const minY = sinkRect.y + WALL_BUFFER;
  const maxY = sinkRect.y + sinkRect.height - WALL_BUFFER;
  const nextX = electron.x + electron.vx * dt;
  const nextY = electron.y + electron.vy * dt;

  // The wall at the connector side is one-way once the electron has committed
  // to the sink. The far side stays open so the particle can leave the model.
  if (direction > 0) {
    const innerWallX = sinkRect.x + WALL_BUFFER;
    if (nextX < innerWallX) {
      electron.x = innerWallX + 0.5;
      electron.vx = Math.abs(electron.vx);
    } else {
      electron.x = nextX;
    }
  } else {
    const innerWallX = sinkRect.x + sinkRect.width - WALL_BUFFER;
    if (nextX > innerWallX) {
      electron.x = innerWallX - 0.5;
      electron.vx = -Math.abs(electron.vx);
    } else {
      electron.x = nextX;
    }
  }

  if (nextY < minY) {
    electron.y = minY + 0.5;
    electron.vy = Math.abs(electron.vy);
  } else if (nextY > maxY) {
    electron.y = maxY - 0.5;
    electron.vy = -Math.abs(electron.vy);
  } else {
    electron.y = nextY;
  }

  return true;
}

function isMovingThroughOpenSinkExit(electron, nextX, potentialDifference) {
  const direction = flowDirection(potentialDifference);
  const sinkRect = sinkRectFor(potentialDifference);
  const insideSinkVertically =
    electron.y >= sinkRect.y + WALL_BUFFER &&
    electron.y <= sinkRect.y + sinkRect.height - WALL_BUFFER;

  if (!insideSinkVertically) return false;

  if (direction > 0) {
    return (
      electron.vx > 0 &&
      electron.x >= sinkRect.x + sinkRect.width - WALL_BUFFER - 4 &&
      nextX > electron.x
    );
  }

  return (
    electron.vx < 0 &&
    electron.x <= sinkRect.x + WALL_BUFFER + 4 &&
    nextX < electron.x
  );
}

function isPastOpenSinkExit(electron, potentialDifference) {
  const direction = flowDirection(potentialDifference);
  const sinkRect = sinkRectFor(potentialDifference);
  const insideSinkVertically =
    electron.y >= sinkRect.y + WALL_BUFFER &&
    electron.y <= sinkRect.y + sinkRect.height - WALL_BUFFER;

  if (!insideSinkVertically) return false;
  return direction > 0
    ? electron.x >= sinkRect.x + sinkRect.width - WALL_BUFFER
    : electron.x <= sinkRect.x + WALL_BUFFER;
}

function recoverElectronFromWall(electron, potentialDifference) {
  if (insideAllowedRegion(electron.x, electron.y)) return;

  // Do not pull an electron back into the apparatus after it has genuinely
  // crossed the open outer edge of the active sink.
  if (isPastOpenSinkExit(electron, potentialDifference)) return;

  const originalX = electron.x;
  const originalY = electron.y;
  const directions = 16;

  // Repulsion or an ion collision can move a centre a few pixels into a wall.
  // Search outward for the nearest valid centre and place it there. This is a
  // positional correction only: no general velocity damping is introduced.
  for (let radius = 1; radius <= WALL_BUFFER * 3.5; radius += 1) {
    for (let i = 0; i < directions; i += 1) {
      const angle = (i / directions) * Math.PI * 2;
      const candidateX = originalX + Math.cos(angle) * radius;
      const candidateY = originalY + Math.sin(angle) * radius;

      if (!insideAllowedRegion(candidateX, candidateY)) continue;

      const correctionX = candidateX - originalX;
      const correctionY = candidateY - originalY;
      electron.x = candidateX;
      electron.y = candidateY;

      // Point any velocity component that was carrying the electron into the
      // wall back toward the valid region. Preserve its speed component.
      if (Math.abs(correctionX) > 0.25 && electron.vx * correctionX < 0) {
        electron.vx *= -1;
      }
      if (Math.abs(correctionY) > 0.25 && electron.vy * correctionY < 0) {
        electron.vy *= -1;
      }
      return;
    }
  }

  // Very rare fallback for a large numerical shove: revert to the previous
  // valid position if possible and reverse both components so it escapes.
  if (insideAllowedRegion(electron.oldX, electron.oldY)) {
    electron.x = electron.oldX;
    electron.y = electron.oldY;
    electron.vx *= -1;
    electron.vy *= -1;
  }
}

function moveElectron(electron, dt, potentialDifference) {
  electron.oldX = electron.x;
  electron.oldY = electron.y;

  // Once committed to the sink, use one-way sink walls rather than the global
  // apparatus geometry. This keeps the electron visible in the sink while
  // guaranteeing that it cannot return through the connector neck.
  if (electron.sinkCommittedDirection !== 0) {
    if (moveCommittedSinkElectron(electron, dt, potentialDifference)) return;
  }

  // First repair any small wall penetration caused by pairwise positional
  // separation on the preceding physics step.
  recoverElectronFromWall(electron, potentialDifference);

  const nextX = electron.x + electron.vx * dt;
  const nextY = electron.y + electron.vy * dt;

  // insideAllowedRegion already includes WALL_BUFFER in each region. Testing
  // the candidate centre directly avoids applying that buffer a second time.
  const canMoveX =
    insideAllowedRegion(nextX, electron.y) &&
    !movementCrossesClosedTerminalWall(
      electron.x,
      electron.y,
      nextX,
      electron.y
    );

  if (canMoveX) {
    electron.x = nextX;
  } else if (isMovingThroughOpenSinkExit(electron, nextX, potentialDifference)) {
    electron.x = nextX;
  } else {
    electron.vx *= -1;
    const nudgeX = electron.x + Math.sign(electron.vx || 1) * 1.25;
    if (insideAllowedRegion(nudgeX, electron.y)) electron.x = nudgeX;
  }

  const canMoveY =
    insideAllowedRegion(electron.x, nextY) &&
    !movementCrossesClosedTerminalWall(
      electron.x,
      electron.y,
      electron.x,
      nextY
    );
  if (canMoveY) {
    electron.y = nextY;
  } else {
    electron.vy *= -1;
    const nudgeY = electron.y + Math.sign(electron.vy || 1) * 1.25;
    if (insideAllowedRegion(electron.x, nudgeY)) electron.y = nudgeY;
  }
}

function ionCollisionRadiusAtCurrent(current) {
  const currentMagnitude = Math.abs(current);
  if (currentMagnitude <= ION_COLLISION_GROWTH_START_CURRENT) {
    return ION_RADIUS;
  }

  const currentFraction = Math.max(
    0,
    Math.min(
      1,
      (currentMagnitude - ION_COLLISION_GROWTH_START_CURRENT) /
        (ION_COLLISION_FULL_SCALE_CURRENT -
          ION_COLLISION_GROWTH_START_CURRENT)
    )
  );

  // Hold the collision envelope at its minimum through 2.5 A, then increase it
  // smoothly toward the existing 30 px maximum at 5 A. A quadratic rise joins
  // the fixed section without an abrupt size jump.
  const shapedCurrent = currentFraction * currentFraction;

  return (
    ION_RADIUS +
    (MAX_ION_COLLISION_RADIUS - ION_RADIUS) * shapedCurrent
  );
}

function collisionScatterAtTemperature(tempC) {
  const heatFraction = Math.max(
    0,
    Math.min(
      1,
      (tempC - AMBIENT_TEMP) / (SCATTER_FULL_SCALE_TEMP - AMBIENT_TEMP)
    )
  );

  // A slightly sub-linear rise makes the extra scattering become noticeable
  // early, then flatten toward a safe maximum at high temperature.
  const shapedHeat = Math.pow(heatFraction, 0.8);
  return (
    COLLISION_SCATTER +
    (MAX_COLLISION_SCATTER - COLLISION_SCATTER) * shapedHeat
  );
}

function escapeSimplifiedElectronFromWallNook(
  electron,
  ion,
  minimumDistance,
  current
) {
  const topY = FILAMENT.y + WALL_BUFFER + 0.75;
  const bottomY = FILAMENT.y + FILAMENT.height - WALL_BUFFER - 0.75;
  const detectionMargin = 2.5;
  const inTopNook =
    ion.y - minimumDistance <= topY + detectionMargin &&
    electron.y < ion.y &&
    electron.y <= topY + detectionMargin;
  const inBottomNook =
    ion.y + minimumDistance >= bottomY - detectionMargin &&
    electron.y > ion.y &&
    electron.y >= bottomY - detectionMargin;

  if (!inTopNook && !inBottomNook) return false;

  const fieldDirection =
    Math.abs(current) > 0.002
      ? current > 0
        ? -1
        : 1
      : Math.sign(electron.vx) || Math.sign(electron.x - ion.x) || 1;
  const existingSide = Math.sign(electron.x - ion.x) || fieldDirection;
  const candidateDirections = [
    fieldDirection,
    existingSide,
    -fieldDirection,
  ].filter((direction, index, directions) =>
    directions.indexOf(direction) === index
  );
  const escapeY = inTopNook ? topY : bottomY;
  let escapeX = null;
  let escapeDirection = fieldDirection;

  for (const direction of candidateDirections) {
    const candidateX =
      ion.x + direction * (minimumDistance + electron.radius + 1.5);
    if (
      pointInRoundedRect(
        candidateX,
        escapeY,
        FILAMENT,
        18,
        WALL_BUFFER
      )
    ) {
      escapeX = candidateX;
      escapeDirection = direction;
      break;
    }
  }

  if (escapeX === null) return false;

  const incomingSpeed = Math.hypot(electron.vx, electron.vy);
  const escapeSpeed = Math.max(24, Math.min(72, incomingSpeed * 0.65));
  electron.x = escapeX;
  electron.y = escapeY;
  electron.oldX = escapeX;
  electron.oldY = escapeY;
  electron.vx = escapeDirection * escapeSpeed;
  electron.vy = inTopNook
    ? Math.max(8, Math.abs(electron.vy) * 0.3)
    : -Math.max(8, Math.abs(electron.vy) * 0.3);
  electron.trail = [];
  electron.trailSampleElapsed = 0;
  electron.nookHoldRemaining = SIMPLIFIED_NOOK_HOLD_SECONDS;
  return true;
}

function scatterFromIons(
  electron,
  ions,
  tempC,
  current,
  simplifiedMotion = false
) {
  if (!pointInRoundedRect(electron.x, electron.y, FILAMENT, 18, 0)) {
    return { depositedHeat: 0, collisions: 0 };
  }

  let depositedHeat = 0;
  let collisions = 0;

  for (const ion of ions) {
    const dx = electron.x - ion.x;
    const dy = electron.y - ion.y;
    const effectiveIonRadius = ionCollisionRadiusAtCurrent(current);
    const minimum = electron.radius + effectiveIonRadius;
    const r2 = dx * dx + dy * dy;

    if (r2 >= minimum * minimum || r2 < 0.0001) continue;

    const distance = Math.sqrt(r2);
    const nx = dx / distance;
    const ny = dy / distance;
    const normalVelocity = electron.vx * nx + electron.vy * ny;

    // Push the electron back outside the ion whether or not it is still moving inward.
    const overlap = minimum - distance;
    electron.x += nx * (overlap + 0.25);
    electron.y += ny * (overlap + 0.25);

    if (
      simplifiedMotion &&
      escapeSimplifiedElectronFromWallNook(
        electron,
        ion,
        minimum,
        current
      )
    ) {
      if (normalVelocity < 0) collisions += 1;
      continue;
    }

    if (normalVelocity >= 0) continue;

    // Count only a genuine incoming impact. Merely remaining slightly overlapped
    // while already moving away from the ion is not a new collision.
    collisions += 1;

    const speed2Before =
      electron.vx * electron.vx + electron.vy * electron.vy;

    if (simplifiedMotion) {
      // Let the ion behave like a Plinko peg: the electron ricochets visibly,
      // then the uniform field gradually restores its directed drift.
      electron.vx -=
        (1 + SIMPLIFIED_COLLISION_RESTITUTION) * normalVelocity * nx;
      electron.vy -=
        (1 + SIMPLIFIED_COLLISION_RESTITUTION) * normalVelocity * ny;
      electron.vx *= SIMPLIFIED_COLLISION_SPEED_RETENTION;
      electron.vy *= SIMPLIFIED_COLLISION_SPEED_RETENTION;
    } else {
      // Inelastic reflection from a very massive ion.
      electron.vx -= (1 + COLLISION_RESTITUTION) * normalVelocity * nx;
      electron.vy -= (1 + COLLISION_RESTITUTION) * normalVelocity * ny;

      // Hotter ions cause stronger directional randomisation. Rotating the velocity
      // preserves the electron speed here: the added resistance comes from loss of
      // directed drift, not from arbitrary temperature-dependent damping.
      const scatterStrength = collisionScatterAtTemperature(tempC);
      const scatterAngle = (Math.random() - 0.5) * scatterStrength;
      const cos = Math.cos(scatterAngle);
      const sin = Math.sin(scatterAngle);
      const vx = electron.vx;
      const vy = electron.vy;
      electron.vx = vx * cos - vy * sin;
      electron.vy = vx * sin + vy * cos;
    }

    const speed2After =
      electron.vx * electron.vx + electron.vy * electron.vy;
    const lostKineticEnergy = Math.max(0, 0.5 * (speed2Before - speed2After));

    // Because the loss from an inelastic impact scales with v^2, faster collisions
    // naturally deposit more thermal energy into the lattice.
    depositedHeat += lostKineticEnergy * COLLISION_HEAT_SCALE;
  }

  return { depositedHeat, collisions };
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawMicroscopicViewportBack(ctx, heatLevel) {
  const frame = {
    x: FILAMENT.x - 12,
    y: FILAMENT.y - 46,
    width: FILAMENT.width + 24,
    height: FILAMENT.height + 64,
  };

  ctx.save();
  ctx.shadowColor = "rgba(31, 50, 65, 0.18)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 7;
  drawRoundedRect(ctx, frame.x, frame.y, frame.width, frame.height, 26);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  drawRoundedRect(ctx, frame.x, frame.y, frame.width, frame.height, 26);
  ctx.strokeStyle = "rgba(116, 137, 151, 0.72)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#20364a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 15px system-ui, sans-serif";
  ctx.fillText(
    "MICROSCOPIC VIEW",
    FILAMENT.x + FILAMENT.width / 2,
    FILAMENT.y - 29
  );
  ctx.fillStyle = "#687985";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.fillText(
    "NOT TO SCALE",
    FILAMENT.x + FILAMENT.width / 2,
    FILAMENT.y - 13
  );

  const glowStrength = Math.pow(heatLevel, 0.72);
  ctx.save();
  ctx.shadowColor = `rgba(255, 103, 24, ${glowStrength * 0.82})`;
  ctx.shadowBlur = 6 + glowStrength * 44;
  drawRoundedRect(
    ctx,
    FILAMENT.x,
    FILAMENT.y,
    FILAMENT.width,
    FILAMENT.height,
    18
  );
  ctx.fillStyle = "rgb(78, 86, 94)";
  ctx.fill();
  ctx.restore();
}

function drawMicroscopicViewportFront(ctx, heatLevel) {
  const glowStrength = Math.pow(heatLevel, 0.72);
  drawRoundedRect(
    ctx,
    FILAMENT.x,
    FILAMENT.y,
    FILAMENT.width,
    FILAMENT.height,
    18
  );
  const borderR = Math.round(53 + 99 * glowStrength);
  const borderG = Math.round(61 + 26 * glowStrength);
  const borderB = Math.round(68 - 42 * glowStrength);
  ctx.strokeStyle = `rgba(${borderR}, ${borderG}, ${borderB}, 0.96)`;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.save();
  drawRoundedRect(
    ctx,
    FILAMENT.x + 5,
    FILAMENT.y + 5,
    FILAMENT.width - 10,
    FILAMENT.height - 10,
    14
  );
  ctx.strokeStyle = `rgba(255, ${Math.round(255 - 45 * glowStrength)}, ${Math.round(255 - 105 * glowStrength)}, ${0.18 + glowStrength * 0.48})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function formatAxisValue(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "Ω") {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return value.toFixed(value >= 100 ? 0 : 1);
  }
  if (unit === "A") {
    return value.toFixed(Number.isInteger(value) ? 0 : 1);
  }
  return value.toFixed(value >= 1 ? 1 : 2);
}

function drawTimeSeriesPanel(
  ctx,
  {
    x,
    y,
    width,
    height,
    title,
    valueText,
    history,
    valueKey,
    now,
    unit,
    defaultMax,
    fixedMax = null,
    lineColor,
    voltageEvents,
    symmetric = false,
  }
) {
  const plotLeft = x + 38;
  const plotTop = y + 28;
  const plotWidth = width - 50;
  const plotHeight = height - 42;
  const startTime = now - AMMETER_HISTORY_MS;

  drawRoundedRect(ctx, x, y, width, height, 9);
  ctx.fillStyle = "rgba(255, 247, 247, 0.98)";
  ctx.fill();
  ctx.strokeStyle = "#b33b3b";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.fillStyle = "#671f1f";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.fillText(title, x + 10, y + 12);

  ctx.textAlign = "right";
  ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(valueText, x + width - 56, y + 12);

  let maxValue = fixedMax ?? defaultMax;

  if (fixedMax === null) {
    for (const point of history) {
      const value = point[valueKey];
      if (!Number.isFinite(value)) continue;
      maxValue = symmetric
        ? Math.max(maxValue, Math.abs(value))
        : Math.max(maxValue, value);
    }
    maxValue *= 1.12;
  }

  ctx.strokeStyle = "rgba(142, 71, 71, 0.16)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i += 1) {
    const gy = plotTop + (plotHeight * i) / 2;
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotLeft + plotWidth, gy);
    ctx.stroke();
  }

  if (symmetric) {
    ctx.strokeStyle = "rgba(103, 31, 31, 0.35)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop + plotHeight / 2);
    ctx.lineTo(plotLeft + plotWidth, plotTop + plotHeight / 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();
  for (const event of voltageEvents) {
    if (event.time < startTime || event.time > now) continue;
    const px =
      plotLeft + ((event.time - startTime) / AMMETER_HISTORY_MS) * plotWidth;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(52, 84, 109, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, plotTop);
    ctx.lineTo(px, plotTop + plotHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  ctx.font = "700 8px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#526a7a";
  for (const event of voltageEvents) {
    if (event.time < startTime || event.time > now) continue;
    const px =
      plotLeft + ((event.time - startTime) / AMMETER_HISTORY_MS) * plotWidth;
    const clampedX = Math.max(
      plotLeft + 12,
      Math.min(plotLeft + plotWidth - 12, px)
    );
    ctx.fillText(`${event.voltage.toFixed(0)} V`, clampedX, plotTop - 5);
  }

  ctx.fillStyle = "#956363";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(
    `${formatAxisValue(maxValue, unit)}${unit}`,
    plotLeft - 4,
    plotTop + 2
  );
  if (symmetric) {
    ctx.fillText("0", plotLeft - 4, plotTop + plotHeight / 2 + 2);
    ctx.fillText(
      `${formatAxisValue(-maxValue, unit)}${unit}`,
      plotLeft - 4,
      plotTop + plotHeight
    );
  } else {
    ctx.fillText("0", plotLeft - 4, plotTop + plotHeight);
  }
  ctx.textAlign = "left";
  ctx.fillText("−20 s", plotLeft, plotTop + plotHeight + 8);
  ctx.textAlign = "right";
  ctx.fillText("now", plotLeft + plotWidth, plotTop + plotHeight + 8);

  if (history.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    const edgeFade = ctx.createLinearGradient(
      plotLeft,
      0,
      plotLeft + Math.min(42, plotWidth * 0.08),
      0
    );
    edgeFade.addColorStop(0, "rgba(212, 49, 49, 0)");
    edgeFade.addColorStop(1, lineColor);
    ctx.strokeStyle = edgeFade;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    let pathOpen = false;
    ctx.beginPath();
    for (const point of history) {
      const value = point[valueKey];
      if (!Number.isFinite(value)) {
        if (pathOpen) {
          ctx.stroke();
          ctx.beginPath();
          pathOpen = false;
        }
        continue;
      }

      const px =
        plotLeft + ((point.time - startTime) / AMMETER_HISTORY_MS) * plotWidth;
      const py = symmetric
        ? plotTop + plotHeight / 2 -
          Math.max(-1, Math.min(1, value / maxValue)) * (plotHeight / 2)
        : plotTop + plotHeight - Math.min(1, value / maxValue) * plotHeight;

      if (!pathOpen) {
        ctx.moveTo(px, py);
        pathOpen = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (pathOpen) ctx.stroke();
    ctx.restore();
  }
}
function drawAmmeterHistory(
  ctx,
  history,
  voltageEvents,
  now,
  liveCurrent,
  displayedCurrent,
  topY,
  minimised = false
) {
  // Keep one rolling current trace beneath the I-V graph. When minimised, draw
  // only a compact header strip; the DOM instrument cluster moves upward to
  // occupy the freed space.
  const width = ANALYSIS_WIDTH;
  const x = ANALYSIS_X;

  if (minimised) {
    const height = HISTORY_PANEL_COLLAPSED_HEIGHT;
    drawRoundedRect(ctx, x, topY, width, height, 9);
    ctx.fillStyle = "rgba(255, 247, 247, 0.98)";
    ctx.fill();
    ctx.strokeStyle = "#b33b3b";
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.fillStyle = "#671f1f";
    ctx.textBaseline = "middle";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("CURRENT OVER TIME", x + 12, topY + height / 2);

    ctx.textAlign = "right";
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(
      `${displayedCurrent.toFixed(3)} A`,
      x + width - 56,
      topY + height / 2
    );
    return;
  }

  // The stored points and header value update every 500 ms, but this live
  // endpoint lets the trace move continuously between those samples.
  const renderedHistory = [
    ...history,
    { time: now, current: liveCurrent },
  ];

  drawTimeSeriesPanel(ctx, {
    x,
    y: topY,
    width,
    height: HISTORY_PANEL_HEIGHT,
    title: "CURRENT OVER TIME",
    valueText: `${displayedCurrent.toFixed(3)} A`,
    history: renderedHistory,
    valueKey: "current",
    now,
    unit: "A",
    defaultMax: 5,
    fixedMax: 5,
    lineColor: "#d43131",
    voltageEvents,
    symmetric: true,
  });
}

function filamentTrendCurrent(voltage) {
  const straightLimit = 5.5;
  const lowVoltageGradient = 0.495;
  const currentAtMaxVoltage = 3.9;
  const magnitude = Math.abs(voltage);

  if (magnitude <= straightLimit) {
    return voltage * lowVoltageGradient;
  }

  // Match the straight section's gradient at 5.5 V, then reduce the gradient
  // smoothly to model the rising resistance of a heating filament.
  // The slightly steeper initial gradient is paired with a tighter bend. The
  // normalised exponential keeps the guide at exactly 3.9 A at 12 V while
  // retaining a smooth join to the straight section.
  const bendScale = 2.58908;
  const extraVoltage = magnitude - straightLimit;
  const maximumExtraVoltage = MAX_VOLTAGE - straightLimit;
  const bendProgress =
    (1 - Math.exp(-extraVoltage / bendScale)) /
    (1 - Math.exp(-maximumExtraVoltage / bendScale));
  const currentMagnitude =
    straightLimit * lowVoltageGradient +
    (currentAtMaxVoltage - straightLimit * lowVoltageGradient) * bendProgress;
  return Math.sign(voltage) * currentMagnitude;
}

function sampleCappedNormalCurrentVariation() {
  // Box-Muller transform: most samples sit close to zero, with the rare tails
  // capped so the simplified model never departs by more than 0.1 A.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const normalSample =
    Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
  return Math.max(
    -SIMPLIFIED_CURRENT_VARIATION_LIMIT,
    Math.min(
      SIMPLIFIED_CURRENT_VARIATION_LIMIT,
      normalSample * SIMPLIFIED_CURRENT_VARIATION_SD
    )
  );
}

function simplifiedBaseCurrentTarget(voltage) {
  if (Math.abs(voltage) < 0.001) return 0;
  return filamentTrendCurrent(voltage);
}

function simplifiedCurrentDuringTransition(transition, now) {
  const progress = Math.max(
    0,
    Math.min(1, (now - transition.start) / SIMPLIFIED_CURRENT_TRANSITION_MS)
  );
  const easedProgress = progress * progress * (3 - 2 * progress);
  return transition.from + (transition.to - transition.from) * easedProgress;
}

function simplifiedNoiseDuringTransition(transition, now) {
  const progress = Math.max(
    0,
    Math.min(
      1,
      (now - transition.start) / SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS
    )
  );
  const easedProgress = progress * progress * (3 - 2 * progress);
  return transition.from + (transition.to - transition.from) * easedProgress;
}

function nextSimplifiedNoiseTarget(voltage) {
  return Math.abs(voltage) < 0.001
    ? 0
    : sampleCappedNormalCurrentVariation();
}

function simplifiedEquilibriumTemperature(voltage, current) {
  const electricalPower = Math.abs(voltage * current);
  const temperatureRise = 69 * Math.pow(electricalPower, 0.814);
  return Math.min(
    BULB_GLOW_FULL_TEMP,
    AMBIENT_TEMP + temperatureRise
  );
}

function applySimplifiedElectronMotion(
  electron,
  dt,
  potentialDifference,
  current
) {
  const direction =
    Math.abs(current) > 0.002
      ? current > 0
        ? -1
        : 1
      : flowDirection(potentialDifference);

  // New and full-mode particles enter this deliberately small simplified
  // state once. This prevents any old steering or repulsion velocity from
  // leaking into the uniform-field model.
  if (!electron.simplifiedMotionInitialised) {
    const verticalDirection = Math.random() < 0.5 ? -1 : 1;
    electron.vx = 0;
    electron.vy = verticalDirection * (10 + Math.random() * 50);
    electron.trail = [];
    electron.trailSampleElapsed = 0;
    electron.simplifiedMotionInitialised = true;
  }

  // This is the complete between-collision model: the same constant horizontal
  // acceleration acts on every electron. Transverse speed remains untouched;
  // only an ion or wall collision may change the direction of motion.
  electron.vx +=
    direction * SIMPLIFIED_FIELD_ACCELERATION_PER_AMP * Math.abs(current) * dt;

  // A high safety ceiling prevents numerical tunnelling after an unusually
  // long collision-free run without shaping ordinary motion.
  const speed = Math.hypot(electron.vx, electron.vy);
  if (speed > SIMPLIFIED_MAX_ELECTRON_SPEED) {
    const scale = SIMPLIFIED_MAX_ELECTRON_SPEED / speed;
    electron.vx *= scale;
    electron.vy *= scale;
  }
}

function recordSimplifiedElectronTrail(electron, dt) {
  electron.trailSampleElapsed += dt;
  if (electron.trailSampleElapsed < SIMPLIFIED_TRAIL_SAMPLE_INTERVAL) return;

  electron.trailSampleElapsed %= SIMPLIFIED_TRAIL_SAMPLE_INTERVAL;
  electron.trail.push({ x: electron.x, y: electron.y });
  if (electron.trail.length > SIMPLIFIED_TRAIL_POSITION_COUNT) {
    electron.trail.splice(
      0,
      electron.trail.length - SIMPLIFIED_TRAIL_POSITION_COUNT
    );
  }
}

function drawIVGraph(ctx, points, minimised = false, showTrendOverlay = false) {
  // The I-V graph anchors the same right-hand analysis column as the current-history
  // panel and instrument cluster. All offsets below are local to this one panel.
  const x = ANALYSIS_X;
  const y = IV_PANEL_Y;
  const width = IV_PANEL_WIDTH;
  const height = minimised ? IV_PANEL_COLLAPSED_HEIGHT : IV_PANEL_HEIGHT;
  // Shift the plot slightly left to leave a clearer right-side gutter for
  // the potential-difference axis label.
  const plotLeft = x + 60;
  const plotTop = y + 58;
  const plotWidth = width - 162;
  const plotHeight = height - 126;

  drawRoundedRect(ctx, x, y, width, height, 10);
  ctx.fillStyle = "rgba(248, 250, 252, 0.98)";
  ctx.fill();
  ctx.strokeStyle = "#7b8791";
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.fillStyle = "#26313a";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.fillText("I–V CHARACTERISTIC", x + 12, y + 16);

  ctx.textAlign = "center";
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.fillStyle = "#65727c";
  ctx.fillText(`${points.length} captured`, x + 240, y + 16);

  if (minimised) {
    return;
  }

  // Fixed current scale for consistent comparison across captured I-V points.
  const currentMax = 5.0;

  // I–V convention used here: potential difference on x, current on y.
  const voltageToX = (voltage) =>
    plotLeft + ((voltage + MAX_VOLTAGE) / (MAX_VOLTAGE * 2)) * plotWidth;
  const currentToY = (current) =>
    plotTop + plotHeight / 2 -
    Math.max(-1, Math.min(1, current / currentMax)) * (plotHeight / 2);

  // Graph-paper grid: each vertical division represents exactly 1 V.
  ctx.strokeStyle = "rgba(92, 105, 116, 0.16)";
  ctx.lineWidth = 1;
  for (let voltageTick = -MAX_VOLTAGE; voltageTick <= MAX_VOLTAGE; voltageTick += 1) {
    const gx = voltageToX(voltageTick);
    ctx.beginPath();
    ctx.moveTo(gx, plotTop);
    ctx.lineTo(gx, plotTop + plotHeight);
    ctx.stroke();
  }
  // Five equal 1 A divisions above and below zero (10 across the full -5 A to +5 A range).
  for (let i = 0; i <= 10; i += 1) {
    const gy = plotTop + (plotHeight * i) / 10;
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotLeft + plotWidth, gy);
    ctx.stroke();
  }

  const zeroX = voltageToX(0);
  const zeroY = currentToY(0);

  // Axes cross at the origin, as in a standard I–V characteristic sketch.
  ctx.strokeStyle = "#35223a";
  ctx.fillStyle = "#35223a";
  ctx.lineWidth = 2;

  // Horizontal potential-difference axis.
  ctx.beginPath();
  ctx.moveTo(plotLeft, zeroY);
  ctx.lineTo(plotLeft + plotWidth + 8, zeroY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(plotLeft + plotWidth + 8, zeroY);
  ctx.lineTo(plotLeft + plotWidth + 1, zeroY - 4);
  ctx.lineTo(plotLeft + plotWidth + 1, zeroY + 4);
  ctx.closePath();
  ctx.fill();

  // Vertical current axis.
  ctx.beginPath();
  ctx.moveTo(zeroX, plotTop + plotHeight);
  ctx.lineTo(zeroX, plotTop - 8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(zeroX, plotTop - 8);
  ctx.lineTo(zeroX - 4, plotTop - 1);
  ctx.lineTo(zeroX + 4, plotTop - 1);
  ctx.closePath();
  ctx.fill();

  // Keep 1 V grid divisions, but label every 2 V along the x-axis.
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "#5c6872";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let value = -MAX_VOLTAGE; value <= MAX_VOLTAGE; value += 2) {
    const tx = voltageToX(value);
    ctx.fillText(`${value.toFixed(0)}`, tx, plotTop + plotHeight + 14);
  }

  // Current-axis numerals: smaller for a cleaner, less crowded scale.
  ctx.font = "13px system-ui, sans-serif";

  // Label every horizontal 1 A division from -5 A to +5 A.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let value = -currentMax; value <= currentMax; value += 1) {
    const ty = currentToY(value);
    const label = Math.abs(value) < currentMax * 0.001 ? "0.0" : value.toFixed(1);
    ctx.fillText(label, plotLeft - 14, ty);
  }

  // Axis labels placed like the reference diagram.
  ctx.fillStyle = "#2c2c2c";
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("Current (A)", zeroX, plotTop - 12);

  // Keep the x-axis title fully inside the I-V panel, with the unit on its
  // own line so the label remains narrow and clear beside the arrow.
  const xAxisLabelRight = x + width - 14;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("Potential", xAxisLabelRight, zeroY - 14);
  ctx.fillText("difference", xAxisLabelRight, zeroY);
  ctx.fillText("(V)", xAxisLabelRight, zeroY + 14);

  if (showTrendOverlay) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    ctx.beginPath();
    for (let step = 0; step <= 240; step += 1) {
      const trendVoltage = -MAX_VOLTAGE + (step / 240) * MAX_VOLTAGE * 2;
      const px = voltageToX(trendVoltage);
      const py = currentToY(filamentTrendCurrent(trendVoltage));
      if (step === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "rgba(91, 62, 151, 0.92)";
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#5b3e97";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Filament bulb trend", plotLeft + 10, plotTop + 9);
  }

  if (points.length === 0) {
    ctx.fillStyle = "rgba(82, 96, 109, 0.72)";
    ctx.font = "24px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "No captured  data points",
      plotLeft + plotWidth / 2 - 6,
      plotTop + plotHeight / 2 - 10
    );
    ctx.font = "20px system-ui, sans-serif";
    ctx.fillText(
      "Set the p.d., let current  settle, then capture",
      plotLeft + plotWidth / 2 - 18,
      plotTop + plotHeight / 2 + 10
    );
    return;
  }

  ctx.save();
  const markerHalfSize = 7;
  ctx.beginPath();
  // Let markers extend beyond the plot boundary by half their size. This keeps
  // endpoint data (for example ±12 V) at its exact axis coordinate while
  // still showing the complete marker.
  ctx.rect(
    plotLeft - markerHalfSize - 2,
    plotTop - markerHalfSize - 2,
    plotWidth + (markerHalfSize + 2) * 2,
    plotHeight + (markerHalfSize + 2) * 2
  );
  ctx.clip();

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Number.isFinite(point.voltage) || !Number.isFinite(point.current)) continue;
    const px = voltageToX(point.voltage);
    const py = currentToY(point.current);

    ctx.beginPath();
    ctx.moveTo(px - markerHalfSize, py - markerHalfSize);
    ctx.lineTo(px + markerHalfSize, py + markerHalfSize);
    ctx.moveTo(px + markerHalfSize, py - markerHalfSize);
    ctx.lineTo(px - markerHalfSize, py + markerHalfSize);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = "#a7195b";
    ctx.lineWidth = 2.8;
    ctx.stroke();
  }
  ctx.restore();
}

function drawScene(ctx, electrons, ions, tempC, liveCurrent, displayedHistoryCurrent, measurementHistory, voltageEvents, ivPoints, now, ivGraphMinimised, currentHistoryMinimised, showTrendOverlay) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, "#f7fafc");
  gradient.addColorStop(1, "#e8edf2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Scale only the rendered particle apparatus. The simulation itself continues
  // to use the original coordinates, sizes, velocities and collision geometry.
  ctx.save();
  ctx.translate(PARTICLE_VIEW_OFFSET_X, PARTICLE_VIEW_OFFSET_Y);
  ctx.scale(PARTICLE_VIEW_SCALE, PARTICLE_VIEW_SCALE);

  const heatLevel = temperatureHeatLevel(tempC);

  // The reservoirs and connector necks remain part of the live physics model,
  // but the learner sees only this magnified window into the filament itself.
  drawMicroscopicViewportBack(ctx, heatLevel);

  // Heat colour is deliberately visual rather than black-body accurate.
  // Cold ions start neutral grey, then warm progressively through rust/red
  // into orange/amber over an even 20 C -> 2000 C temperature scale.
  const heatStops = [
    { t: 0.00, rgb: [118, 126, 134] },  // cool steel grey -- 20 C
    { t: 0.25, rgb: [148, 105, 88] },  // warm grey / rust -- ~515 C
    { t: 0.50, rgb: [207, 45, 34] },   // red -- ~1010 C
    { t: 0.75, rgb: [242, 78, 20] },   // orange-red -- ~1505 C
    { t: 1.00, rgb: [255, 158, 31] },  // hot orange/amber -- 2000 C
  ];

  function sampleHeatColour(t) {
    for (let i = 0; i < heatStops.length - 1; i += 1) {
      const a = heatStops[i];
      const b = heatStops[i + 1];
      if (t <= b.t) {
        const f = (t - a.t) / (b.t - a.t);
        return a.rgb.map((value, channel) =>
          Math.round(value + (b.rgb[channel] - value) * f)
        );
      }
    }
    return heatStops[heatStops.length - 1].rgb;
  }

  const [heatR, heatG, heatB] = sampleHeatColour(heatLevel);

  ctx.save();
  drawRoundedRect(
    ctx,
    FILAMENT.x,
    FILAMENT.y,
    FILAMENT.width,
    FILAMENT.height,
    18
  );
  ctx.clip();

  for (const ion of ions) {
    // Draw ions 20% larger without changing ion.radius itself. The stored radius
    // continues to drive collision geometry and particle-seeding clearance.
    const visualRadius = ion.radius * 1.76;

    // Brighter centre and stronger halo make increasing lattice temperature
    // immediately legible, while the base hue still carries the temperature cue.
    const centreR = Math.min(255, Math.round(heatR + (255 - heatR) * 0.42));
    const centreG = Math.min(255, Math.round(heatG + (255 - heatG) * 0.42));
    const centreB = Math.min(255, Math.round(heatB + (255 - heatB) * 0.42));
    const edgeR = Math.round(heatR * 0.58);
    const edgeG = Math.round(heatG * 0.52);
    const edgeB = Math.round(heatB * 0.48);

    ctx.save();
    ctx.shadowColor = `rgba(${heatR}, ${heatG}, ${heatB}, ${0.08 + heatLevel * 0.76})`;
    ctx.shadowBlur = 2 + heatLevel * 20;

    const g = ctx.createRadialGradient(
      ion.x - visualRadius * 0.32,
      ion.y - visualRadius * 0.32,
      visualRadius * 0.12,
      ion.x,
      ion.y,
      visualRadius
    );
    g.addColorStop(0, `rgb(${centreR}, ${centreG}, ${centreB})`);
    g.addColorStop(0.42, `rgb(${heatR}, ${heatG}, ${heatB})`);
    g.addColorStop(1, `rgb(${edgeR}, ${edgeG}, ${edgeB})`);

    ctx.beginPath();
    ctx.arc(ion.x, ion.y, visualRadius, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();

  ctx.save();
  drawRoundedRect(
    ctx,
    FILAMENT.x,
    FILAMENT.y,
    FILAMENT.width,
    FILAMENT.height,
    18
  );
  ctx.clip();

  for (const electron of electrons) {
    if (electron.nookHoldRemaining > 0) continue;
    if (!inConductor(electron)) continue;

    if (electron.trail?.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let index = 0; index < electron.trail.length; index += 1) {
        const position = electron.trail[index];
        const recency = (index + 1) / electron.trail.length;
        const alpha = 0.025 + Math.pow(recency, 1.7) * 0.2;
        const radius = electron.radius * (0.25 + recency * 0.42);
        ctx.beginPath();
        ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(99, 217, 255, ${alpha})`;
        ctx.fill();
      }
      ctx.restore();
    } else {
      // Detailed mode retains its compact instantaneous velocity mark.
      const speed = Math.hypot(electron.vx, electron.vy);
      const trailScale = Math.min(0.08, 3.8 / Math.max(speed, 1));

      ctx.beginPath();
      ctx.moveTo(electron.x, electron.y);
      ctx.lineTo(
        electron.x - electron.vx * trailScale,
        electron.y - electron.vy * trailScale
      );
      ctx.strokeStyle = "rgba(38, 175, 232, 0.28)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const g = ctx.createRadialGradient(
      electron.x - electron.radius * 0.35,
      electron.y - electron.radius * 0.35,
      electron.radius * 0.15,
      electron.x,
      electron.y,
      electron.radius
    );
    g.addColorStop(0, "#e9fcff");
    g.addColorStop(0.38, "#63d9ff");
    g.addColorStop(1, "#0878b6");

    ctx.beginPath();
    ctx.arc(electron.x, electron.y, electron.radius, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  ctx.restore();

  drawMicroscopicViewportFront(ctx, heatLevel);

  ctx.restore();

  // Analysis panels occupy the aligned right-hand column.
  drawAmmeterHistory(
    ctx,
    measurementHistory,
    voltageEvents,
    now,
    liveCurrent,
    displayedHistoryCurrent,
    historyPanelTop(ivGraphMinimised),
    currentHistoryMinimised
  );
  drawIVGraph(ctx, ivPoints, ivGraphMinimised, showTrendOverlay);
}
export default function App() {
  const canvasRef = useRef(null);
  const microscopicOverlayRef = useRef(null);
  const electronsRef = useRef([]);
  const ionsRef = useRef(makeIonLattice());
  const voltageRef = useRef(DEFAULT_VOLTAGE);
  const temperatureRef = useRef(AMBIENT_TEMP);
  const currentRef = useRef(0);
  const crossingsRef = useRef([]);
  const collisionDiagnosticRef = useRef([]);
  const measurementTimeRef = useRef(0);
  const simplifiedTimeRef = useRef(0);
  const ionAnimationTimeRef = useRef(0);
  const historyTimeRef = useRef(0);
  const currentHistoryRef = useRef([]);
  const voltageEventsRef = useRef([]);
  const ivPointsRef = useRef([]);
  const lastHistorySampleRef = useRef(0);
  const pausedRef = useRef(false);
  const simplifiedModeRef = useRef(true);
  const simplifiedCurrentTransitionRef = useRef(null);
  if (simplifiedCurrentTransitionRef.current === null) {
    simplifiedCurrentTransitionRef.current = {
      from: 0,
      to: simplifiedBaseCurrentTarget(DEFAULT_VOLTAGE),
      start: 0,
    };
  }
  const simplifiedCurrentNoiseRef = useRef(null);
  if (simplifiedCurrentNoiseRef.current === null) {
    simplifiedCurrentNoiseRef.current = {
      from: 0,
      to: nextSimplifiedNoiseTarget(DEFAULT_VOLTAGE),
      start: 0,
      nextSample: SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS,
    };
  }

  const [voltage, setVoltage] = useState(DEFAULT_VOLTAGE);
  const [paused, setPaused] = useState(false);
  const [simplifiedMode, setSimplifiedMode] = useState(true);
  const [showIVGraphExplanation, setShowIVGraphExplanation] = useState(false);
  const [ivGraphMinimised, setIvGraphMinimised] = useState(false);
  const [showTrendOverlay, setShowTrendOverlay] = useState(false);
  const [analogueMeterMinimised, setAnalogueMeterMinimised] = useState(false);
  const [digitalCurrentMinimised, setDigitalCurrentMinimised] = useState(false);
  const [resistanceMinimised, setResistanceMinimised] = useState(false);
  const [currentHistoryMinimised, setCurrentHistoryMinimised] = useState(false);
  const [temperatureMinimised, setTemperatureMinimised] = useState(false);
  const ivGraphMinimisedRef = useRef(false);
  const showTrendOverlayRef = useRef(false);
  const currentHistoryMinimisedRef = useRef(false);
  const [readout, setReadout] = useState({
    current: 0,
    resistance: null,
    temperature: AMBIENT_TEMP,
    collisionsPerElectronPerSecond: 0,
    reservoirCount: 0,
    totalElectrons: 0,
  });

  useEffect(() => {
    voltageRef.current = voltage;
  }, [voltage]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!showIVGraphExplanation) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setShowIVGraphExplanation(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showIVGraphExplanation]);

  useEffect(() => {
    ivGraphMinimisedRef.current = ivGraphMinimised;
  }, [ivGraphMinimised]);

  useEffect(() => {
    showTrendOverlayRef.current = showTrendOverlay;
  }, [showTrendOverlay]);

  useEffect(() => {
    currentHistoryMinimisedRef.current = currentHistoryMinimised;
  }, [currentHistoryMinimised]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const microscopicOverlay = microscopicOverlayRef.current;
    if (!canvas || !microscopicOverlay) return undefined;

    const ctx = canvas.getContext("2d");
    const microscopicOverlayCtx = microscopicOverlay.getContext("2d");
    ctx.setTransform(
      CANVAS_RENDER_SCALE,
      0,
      0,
      CANVAS_RENDER_SCALE,
      0,
      0
    );

    // Start with charge already distributed through the filament. Its initial
    // density is half the reservoir density at the selected starting voltage.
    if (electronsRef.current.length === 0) {
      electronsRef.current = makeInitialElectronPopulation(
        voltageRef.current,
        ionsRef.current,
        simplifiedModeRef.current
      );
    }

    let animationId;
    let lastTime = performance.now();
    let lastUiUpdate = 0;
    let lastTemperatureReadoutUpdate = 0;

    const frame = (now) => {
      const rawDt = (now - lastTime) / 1000;
      const dt = Math.min(rawDt, 0.032);
      lastTime = now;

      const electrons = electronsRef.current;
      const ions = ionsRef.current;
      const simplifiedMotion = simplifiedModeRef.current;
      const targetCount = voltageToTargetCount(
        voltageRef.current,
        simplifiedMotion
      );
      const maxTotalElectrons = simplifiedMotion
        ? SIMPLIFIED_MAX_TOTAL_ELECTRONS
        : MAX_TOTAL_ELECTRONS;
      let simplifiedCurrent = currentRef.current;

      if (!pausedRef.current) {
        measurementTimeRef.current += dt * 1000;
        simplifiedTimeRef.current += rawDt * 1000;
        ionAnimationTimeRef.current += rawDt;
        historyTimeRef.current += rawDt * 1000;
        if (simplifiedModeRef.current) {
          const baseCurrent = simplifiedCurrentDuringTransition(
            simplifiedCurrentTransitionRef.current,
            simplifiedTimeRef.current
          );
          let noiseTransition = simplifiedCurrentNoiseRef.current;
          if (simplifiedTimeRef.current >= noiseTransition.nextSample) {
            const currentNoise = simplifiedNoiseDuringTransition(
              noiseTransition,
              simplifiedTimeRef.current
            );
            noiseTransition = {
              from: currentNoise,
              to: nextSimplifiedNoiseTarget(voltageRef.current),
              start: simplifiedTimeRef.current,
              nextSample:
                simplifiedTimeRef.current +
                SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS,
            };
            simplifiedCurrentNoiseRef.current = noiseTransition;
          }
          simplifiedCurrent =
            baseCurrent +
            simplifiedNoiseDuringTransition(
              noiseTransition,
              simplifiedTimeRef.current
            );
        }
        maintainReservoirPopulation(
          electrons,
          targetCount,
          voltageRef.current,
          maxTotalElectrons
        );
        updateIons(
          ions,
          temperatureRef.current,
          ionAnimationTimeRef.current
        );
        if (!simplifiedModeRef.current) {
          repelElectrons(electrons, dt);
        }

        let collisionHeat = 0;
        let frameCollisionCount = 0;
        const conductorElectronCount = electrons.reduce(
          (count, electron) => count + (inConductor(electron) ? 1 : 0),
          0
        );

        for (const electron of electrons) {
          if (
            simplifiedModeRef.current &&
            electron.nookHoldRemaining > 0
          ) {
            electron.nookHoldRemaining = Math.max(
              0,
              electron.nookHoldRemaining - rawDt
            );
            electron.oldX = electron.x;
            electron.oldY = electron.y;
            continue;
          }

          if (simplifiedModeRef.current) {
            applySimplifiedElectronMotion(
              electron,
              dt,
              voltageRef.current,
              simplifiedCurrent
            );
            recordSimplifiedElectronTrail(electron, dt);
          }
          moveElectron(electron, dt, voltageRef.current);
          const collisionResult = scatterFromIons(
            electron,
            ions,
            temperatureRef.current,
            simplifiedModeRef.current
              ? simplifiedCurrent
              : currentRef.current,
            simplifiedModeRef.current
          );
          collisionHeat += collisionResult.depositedHeat;
          frameCollisionCount += collisionResult.collisions;

          if (electron.sinkCommittedDirection === 0) {
            // Ion scattering can also displace an electron into a nearby wall;
            // repair that immediately instead of letting it remain pinned there.
            recoverElectronFromWall(electron, voltageRef.current);
            maybeCommitElectronToSink(electron, voltageRef.current);
          } else {
            // Pairwise repulsion happens before movement and can numerically
            // nudge committed sink electrons toward the connector. Re-apply the
            // one-way sink boundary without advancing time to keep them inside.
            moveCommittedSinkElectron(electron, 0, voltageRef.current);
          }

          // Measure net charge flow through the ammeter plane. Every crossing
          // counts, regardless of the active source/sink direction:
          // left -> right = +1, right -> left = -1. An electron may therefore
          // contribute again if it later crosses back through the plane.
          let crossingDirection = 0;
          if (electron.oldX < AMMETER_X && electron.x >= AMMETER_X) {
            crossingDirection = 1;
          } else if (electron.oldX > AMMETER_X && electron.x <= AMMETER_X) {
            crossingDirection = -1;
          }

          if (
            crossingDirection !== 0 &&
            pointInRoundedRect(electron.x, electron.y, FILAMENT, 18, 0)
          ) {
            crossingsRef.current.push({
              time: measurementTimeRef.current,
              direction: crossingDirection,
            });
          }
        }

        collisionDiagnosticRef.current.push({
          time: measurementTimeRef.current,
          collisions: frameCollisionCount,
          electronSeconds: conductorElectronCount * dt,
        });

        if (simplifiedModeRef.current) {
          const equilibriumTemperature = simplifiedEquilibriumTemperature(
            voltageRef.current,
            simplifiedCurrent
          );
          temperatureRef.current +=
            COOLING_RATE *
            (equilibriumTemperature - AMBIENT_TEMP) *
            dt;
        } else {
          temperatureRef.current += collisionHeat;
        }

        // Exponential passive cooling to the fixed 20 C ambient temperature.
        const excess = temperatureRef.current - AMBIENT_TEMP;
        temperatureRef.current =
          AMBIENT_TEMP + excess * Math.exp(-COOLING_RATE * dt);

        // Electrons remain visible inside the absorbing sink chamber. Once
        // committed, they cannot return through the neck and are removed only
        // after passing through the sink's open outer boundary.
        const direction = flowDirection(voltageRef.current);
        electronsRef.current = electrons.filter((electron) =>
          direction > 0
            ? electron.x < RIGHT_EXIT_X
            : electron.x > LEFT_EXIT_X
        );
      }

      // Use a true 5-second rolling average of signed crossing rate. Electron
      // flow is opposite to conventional current, so invert the signed electron
      // crossings before displaying current. The
      // measurement clock advances only while the simulation is running, so
      // pausing also freezes the rolling-average window.
      const measurementNow = measurementTimeRef.current;
      crossingsRef.current = crossingsRef.current.filter(
        (crossing) =>
          measurementNow - crossing.time <= CURRENT_AVERAGE_WINDOW_MS
      );
      const netCrossings = crossingsRef.current.reduce(
        (sum, crossing) => sum + crossing.direction,
        0
      );
      const measuredCurrent =
        (-netCrossings / (CURRENT_AVERAGE_WINDOW_MS / 1000)) * CURRENT_SCALE;
      const current = simplifiedModeRef.current
        ? simplifiedCurrent
        : measuredCurrent;
      currentRef.current = current;
      const currentMatchesPolarity =
        Math.abs(current) > 0.002 && voltageRef.current * current > 0;
      const resistance = currentMatchesPolarity
        ? voltageRef.current / current
        : null;

      collisionDiagnosticRef.current = collisionDiagnosticRef.current.filter(
        (sample) =>
          measurementNow - sample.time <= COLLISION_DIAGNOSTIC_WINDOW_MS
      );
      const diagnosticTotals = collisionDiagnosticRef.current.reduce(
        (totals, sample) => {
          totals.collisions += sample.collisions;
          totals.electronSeconds += sample.electronSeconds;
          return totals;
        },
        { collisions: 0, electronSeconds: 0 }
      );
      const collisionsPerElectronPerSecond =
        diagnosticTotals.electronSeconds > 0
          ? diagnosticTotals.collisions / diagnosticTotals.electronSeconds
          : 0;

      const historyNow = historyTimeRef.current;
      if (
        !pausedRef.current &&
        historyNow - lastHistorySampleRef.current >= AMMETER_HISTORY_SAMPLE_MS
      ) {
        lastHistorySampleRef.current = historyNow;
        currentHistoryRef.current.push({
          time: historyNow,
          current,
          resistance,
        });
      }
      currentHistoryRef.current = currentHistoryRef.current.filter(
        (point) =>
          historyNow - point.time <=
          AMMETER_HISTORY_MS + AMMETER_HISTORY_EDGE_BUFFER_MS
      );
      const latestHistoryPoint =
        currentHistoryRef.current[currentHistoryRef.current.length - 1];
      const displayedHistoryCurrent = latestHistoryPoint?.current ?? 0;
      voltageEventsRef.current = voltageEventsRef.current.filter(
        (event) => historyNow - event.time <= AMMETER_HISTORY_MS
      );

      const reservoirCount = electronsRef.current.reduce(
        (count, electron) => count + (inSourceReservoir(electron, voltageRef.current) ? 1 : 0),
        0
      );

      drawScene(
        ctx,
        electronsRef.current,
        ions,
        temperatureRef.current,
        current,
        displayedHistoryCurrent,
        currentHistoryRef.current,
        voltageEventsRef.current,
        ivPointsRef.current,
        historyNow,
        ivGraphMinimisedRef.current,
        currentHistoryMinimisedRef.current,
        showTrendOverlayRef.current
      );

      // Repaint the microscopic panel on a foreground canvas. The zoom wedge
      // can therefore continue beneath its left edge without tinting the
      // lattice, particles, headings, or frame.
      microscopicOverlayCtx.clearRect(
        0,
        0,
        microscopicOverlay.width,
        microscopicOverlay.height
      );
      const microscopicSourceX = Math.round(
        MICROSCOPIC_FRAME_RENDER.x * CANVAS_RENDER_SCALE
      );
      const microscopicSourceY = Math.round(
        MICROSCOPIC_FRAME_RENDER.y * CANVAS_RENDER_SCALE
      );
      const microscopicSourceWidth = Math.round(
        MICROSCOPIC_FRAME_RENDER.width * CANVAS_RENDER_SCALE
      );
      const microscopicSourceHeight = Math.round(
        MICROSCOPIC_FRAME_RENDER.height * CANVAS_RENDER_SCALE
      );
      microscopicOverlayCtx.drawImage(
        canvas,
        microscopicSourceX,
        microscopicSourceY,
        microscopicSourceWidth,
        microscopicSourceHeight,
        microscopicSourceX,
        microscopicSourceY,
        microscopicSourceWidth,
        microscopicSourceHeight
      );

      if (now - lastUiUpdate > 120) {
        lastUiUpdate = now;
        const updateTemperatureReadout =
          now - lastTemperatureReadoutUpdate >= 500;
        if (updateTemperatureReadout) {
          lastTemperatureReadoutUpdate = now;
        }

        setReadout((previousReadout) => ({
          current,
          resistance,
          temperature: updateTemperatureReadout
            ? temperatureRef.current
            : previousReadout.temperature,
          collisionsPerElectronPerSecond,
          reservoirCount,
          totalElectrons: electronsRef.current.length,
        }));
      }

      animationId = requestAnimationFrame(frame);
    };

    animationId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationId);
  }, []);

  const resetSimulation = () => {
    ionsRef.current = makeIonLattice();
    electronsRef.current = makeInitialElectronPopulation(
      voltageRef.current,
      ionsRef.current,
      simplifiedModeRef.current
    );
    crossingsRef.current = [];
    collisionDiagnosticRef.current = [];
    measurementTimeRef.current = 0;
    simplifiedTimeRef.current = 0;
    ionAnimationTimeRef.current = 0;
    historyTimeRef.current = 0;
    currentHistoryRef.current = [];
    voltageEventsRef.current = [];
    // Preserve captured I-V points when resetting the simulation.
    lastHistorySampleRef.current = 0;
    temperatureRef.current = AMBIENT_TEMP;
    currentRef.current = 0;
    if (simplifiedModeRef.current) {
      simplifiedCurrentTransitionRef.current = {
        from: 0,
        to: simplifiedBaseCurrentTarget(voltageRef.current),
        start: 0,
      };
      simplifiedCurrentNoiseRef.current = {
        from: 0,
        to: nextSimplifiedNoiseTarget(voltageRef.current),
        start: 0,
        nextSample: SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS,
      };
    }

    const reservoirCount = electronsRef.current.reduce(
      (count, electron) => count + (inSourceReservoir(electron, voltageRef.current) ? 1 : 0),
      0
    );

    setReadout({
      current: 0,
      resistance: null,
      temperature: AMBIENT_TEMP,
      collisionsPerElectronPerSecond: 0,
      reservoirCount,
      totalElectrons: electronsRef.current.length,
    });
  };

  const toggleSimplifiedMode = () => {
    const nextSimplifiedMode = !simplifiedModeRef.current;
    simplifiedModeRef.current = nextSimplifiedMode;
    setSimplifiedMode(nextSimplifiedMode);

    crossingsRef.current = [];
    collisionDiagnosticRef.current = [];
    electronsRef.current = makeInitialElectronPopulation(
      voltageRef.current,
      ionsRef.current,
      nextSimplifiedMode
    );

    if (nextSimplifiedMode) {
      simplifiedCurrentTransitionRef.current = {
        from: currentRef.current,
        to: simplifiedBaseCurrentTarget(voltageRef.current),
        start: simplifiedTimeRef.current,
      };
      simplifiedCurrentNoiseRef.current = {
        from: 0,
        to: nextSimplifiedNoiseTarget(voltageRef.current),
        start: simplifiedTimeRef.current,
        nextSample:
          simplifiedTimeRef.current + SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS,
      };
    } else {
      // Hand control back to the unchanged crossing-based current model.
      currentRef.current = 0;
    }
  };

  const applyVoltage = (requestedVoltage) => {
    const nextVoltage = Math.max(
      -MAX_VOLTAGE,
      Math.min(MAX_VOLTAGE, Math.round(Number(requestedVoltage) * 2) / 2)
    );
    const simplifiedMotion = simplifiedModeRef.current;
    const nextTarget = voltageToTargetCount(nextVoltage, simplifiedMotion);
    const maxTotalElectrons = simplifiedMotion
      ? SIMPLIFIED_MAX_TOTAL_ELECTRONS
      : MAX_TOTAL_ELECTRONS;
    const historyNow = historyTimeRef.current;
    const previousDirection = flowDirection(voltageRef.current);
    const nextDirection = flowDirection(nextVoltage);

    const voltageEvents = voltageEventsRef.current;
    const lastEvent = voltageEvents[voltageEvents.length - 1];
    if (lastEvent && historyNow - lastEvent.time < 450) {
      lastEvent.time = historyNow;
      lastEvent.voltage = nextVoltage;
    } else {
      voltageEvents.push({ time: historyNow, voltage: nextVoltage });
    }

    // When polarity reverses, the old reservoir becomes the sink. Clear both
    // external chambers but preserve every electron already in the conductor,
    // then seed the new reservoir on the opposite side.
    if (previousDirection !== nextDirection) {
      electronsRef.current = electronsRef.current.filter(inConductor);
    }

    voltageRef.current = nextVoltage;
    setVoltage(nextVoltage);
    if (simplifiedModeRef.current) {
      const transitionTime = simplifiedTimeRef.current;
      const currentBase = simplifiedCurrentDuringTransition(
        simplifiedCurrentTransitionRef.current,
        transitionTime
      );
      const currentNoise = simplifiedNoiseDuringTransition(
        simplifiedCurrentNoiseRef.current,
        transitionTime
      );
      simplifiedCurrentTransitionRef.current = {
        from: currentBase,
        to: simplifiedBaseCurrentTarget(nextVoltage),
        start: transitionTime,
      };
      simplifiedCurrentNoiseRef.current = {
        from: currentNoise,
        to: nextSimplifiedNoiseTarget(nextVoltage),
        start: transitionTime,
        nextSample:
          transitionTime + SIMPLIFIED_CURRENT_NOISE_SAMPLE_MS,
      };
    }
    electronsRef.current = rebuildReservoirPopulation(
      electronsRef.current,
      nextTarget,
      nextVoltage,
      maxTotalElectrons
    );
  };

  const handleVoltageChange = (event) => {
    applyVoltage(event.target.value);
  };

  const setVoltageFromSliderPointer = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const proportion = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width)
    );
    applyVoltage(-MAX_VOLTAGE + proportion * MAX_VOLTAGE * 2);
  };

  const handleVoltagePointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setVoltageFromSliderPointer(event);
  };

  const handleVoltagePointerMove = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setVoltageFromSliderPointer(event);
  };

  const handleVoltagePointerUp = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setVoltageFromSliderPointer(event);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleVoltagePointerCancel = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const stepVoltage = (delta) => {
    applyVoltage(voltageRef.current + delta);
  };

  const captureDataPoint = () => {
    let current = currentRef.current;
    if (!simplifiedModeRef.current) {
      const measurementNow = measurementTimeRef.current;
      crossingsRef.current = crossingsRef.current.filter(
        (crossing) =>
          measurementNow - crossing.time <= CURRENT_AVERAGE_WINDOW_MS
      );
      const netCrossings = crossingsRef.current.reduce(
        (sum, crossing) => sum + crossing.direction,
        0
      );
      current =
        (-netCrossings / (CURRENT_AVERAGE_WINDOW_MS / 1000)) * CURRENT_SCALE;
    }

    ivPointsRef.current.push({
      voltage: voltageRef.current,
      current,
    });
  };

  const clearCapturedData = () => {
    ivPointsRef.current = [];
  };

  const bulbHeatLevel = bulbGlowHeatLevel(readout.temperature);
  const bulbGlowStrength = Math.pow(bulbHeatLevel, 0.58);
  const bulbColourHeatLevel = Math.pow(bulbHeatLevel, 0.72);
  const bulbGlowGreen = Math.round(190 + 45 * bulbColourHeatLevel);
  const bulbGlowBlue = Math.round(65 + 95 * bulbColourHeatLevel);
  const bulbOuterGreen = Math.round(135 + 90 * bulbColourHeatLevel);
  const bulbOuterBlue = Math.round(35 + 75 * bulbColourHeatLevel);
  const bulbCoreGreen = Math.round(232 + 23 * bulbColourHeatLevel);
  const bulbCoreBlue = Math.round(150 + 80 * bulbColourHeatLevel);
  // Keep the filament itself visibly red-hot at moderate temperatures, then
  // let it progress through orange to yellow-white as it approaches 1600 C.
  const filamentCoreGreen = Math.round(
    45 + 200 * Math.pow(bulbHeatLevel, 1.15)
  );
  const filamentCoreBlue = Math.round(
    15 + 175 * Math.pow(bulbHeatLevel, 1.4)
  );
  const filamentAuraGreen = Math.round(
    20 + 155 * Math.pow(bulbHeatLevel, 1.1)
  );
  const filamentAuraBlue = Math.round(
    5 + 90 * Math.pow(bulbHeatLevel, 1.4)
  );
  const activeCircuitDiagram =
    voltage < 0 ? negativeCircuitDiagram : positiveCircuitDiagram;
  const hasTerminalPolarity = Math.abs(voltage) > 0.001;
  const leftTerminalPolarity = hasTerminalPolarity
    ? voltage > 0
      ? "positive"
      : "negative"
    : "neutral";
  const rightTerminalPolarity = hasTerminalPolarity
    ? voltage > 0
      ? "negative"
      : "positive"
    : "neutral";
  const electronFlowDirection = hasTerminalPolarity
    ? flowDirection(voltage) > 0
      ? "right"
      : "left"
    : "none";
  const currentFlowDirection = hasTerminalPolarity
    ? electronFlowDirection === "right"
      ? "left"
      : "right"
    : "none";

  return (
    <div className="fs-page">
      <style>{layoutCss}</style>

      <main className="fs-shell">
        <header className="fs-header">
          <h1>Filament conduction simulation</h1>

          <div className="fs-header-actions">
            <label className="fs-simplified-mode-toggle">
              <input
                type="checkbox"
                checked={simplifiedMode}
                onChange={toggleSimplifiedMode}
                aria-label="Simplified electron motion"
              />
              <span className="fs-simplified-mode-track" aria-hidden="true">
                <span className="fs-simplified-mode-thumb" />
              </span>
              <span>Simplified electron motion</span>
            </label>

            <button
              type="button"
              className="fs-circuit-diagram-button"
              onClick={() => setShowIVGraphExplanation(true)}
            >
              I-V graph explanation
            </button>

          </div>
        </header>

        <section className="fs-stage-card" aria-label="Particle simulation, graphs, and instruments">
          <div className="fs-stage-controls" aria-label="Simulation controls">
            <div className="fs-voltage-control">
              <div className="fs-voltage-heading">
                <strong>Potential difference:</strong>
                <span className="fs-voltage-value">{voltage.toFixed(1)} V</span>
              </div>

              <div className="fs-voltage-stepper">
                <button
                  type="button"
                  className="fs-voltage-step-button"
                  onClick={() => stepVoltage(-0.5)}
                  disabled={voltage <= -MAX_VOLTAGE}
                  aria-label="Decrease potential difference by 0.5 volts"
                  title="Decrease by 0.5 V"
                >
                  −
                </button>

                <div
                  className="fs-slider-wrap"
                  style={{
                    "--slider-active-start": `${Math.min(
                      50,
                      ((voltage + MAX_VOLTAGE) / (MAX_VOLTAGE * 2)) * 100
                    )}%`,
                    "--slider-active-end": `${Math.max(
                      50,
                      ((voltage + MAX_VOLTAGE) / (MAX_VOLTAGE * 2)) * 100
                    )}%`,
                    "--slider-thumb-position": `${
                      ((voltage + MAX_VOLTAGE) / (MAX_VOLTAGE * 2)) * 100
                    }%`,
                  }}
                >
                  <input
                    className="fs-slider"
                    type="range"
                    min={-MAX_VOLTAGE}
                    max={MAX_VOLTAGE}
                    step="0.5"
                    value={voltage}
                    onChange={handleVoltageChange}
                    onPointerDown={handleVoltagePointerDown}
                    onPointerMove={handleVoltagePointerMove}
                    onPointerUp={handleVoltagePointerUp}
                    onPointerCancel={handleVoltagePointerCancel}
                    aria-label="Potential difference"
                  />
                  <span className="fs-slider-thumb" aria-hidden="true" />
                  <span className="fs-slider-zero-tick" aria-hidden="true" />
                  <span className="fs-slider-zero-label" aria-hidden="true">
                    0 V
                  </span>
                </div>

                <button
                  type="button"
                  className="fs-voltage-step-button"
                  onClick={() => stepVoltage(0.5)}
                  disabled={voltage >= MAX_VOLTAGE}
                  aria-label="Increase potential difference by 0.5 volts"
                  title="Increase by 0.5 V"
                >
                  +
                </button>
              </div>

            </div>

            <div className="fs-control-side">
              <div className="fs-actions">
                <button
                  onClick={captureDataPoint}
                  style={{
                    ...buttonStyle,
                    background: "#a7195b",
                    border: "1px solid #861347",
                    color: "#ffffff",
                  }}
                >
                  Capture data point
                </button>
                <button
                  className="fs-clear-data-button"
                  onClick={clearCapturedData}
                  style={buttonStyle}
                >
                  Clear data
                </button>
                <button
                  className="fs-pause-button"
                  onClick={() => setPaused((value) => !value)}
                  style={buttonStyle}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  className="fs-refresh-electrons-button"
                  onClick={resetSimulation}
                  style={buttonStyle}
                >
                  Refresh electrons
                </button>
              </div>
            </div>
          </div>

          <div className="fs-stage-wrap">
            <canvas
              ref={canvasRef}
              width={WIDTH * CANVAS_RENDER_SCALE}
              height={HEIGHT * CANVAS_RENDER_SCALE}
              className="fs-stage"
            />

            <canvas
              ref={microscopicOverlayRef}
              width={WIDTH * CANVAS_RENDER_SCALE}
              height={HEIGHT * CANVAS_RENDER_SCALE}
              className="fs-microscopic-overlay"
              aria-hidden="true"
            />

            <img
              src={activeCircuitDiagram}
              alt={`Series circuit with a ${voltage < 0 ? "negative" : "positive"} potential difference and ammeter`}
              className="fs-circuit-context-image"
            />

            <div
              className="fs-circuit-bulb"
              style={{
                "--bulb-glow-green": bulbGlowGreen,
                "--bulb-glow-blue": bulbGlowBlue,
                "--bulb-outer-green": bulbOuterGreen,
                "--bulb-outer-blue": bulbOuterBlue,
                "--bulb-core-green": bulbCoreGreen,
                "--bulb-core-blue": bulbCoreBlue,
                "--filament-core-green": filamentCoreGreen,
                "--filament-core-blue": filamentCoreBlue,
                "--filament-aura-green": filamentAuraGreen,
                "--filament-aura-blue": filamentAuraBlue,
              }}
            >
              <span
                className="fs-circuit-bulb-glow"
                style={{
                  opacity: Math.min(1, bulbGlowStrength * 1.1),
                  transform: `scale(${0.76 + bulbGlowStrength * 0.9})`,
                }}
                aria-hidden="true"
              />
              <img
                src={uprightBulb}
                alt="Upright filament bulb connected into the series circuit"
                className="fs-circuit-bulb-image"
                style={{
                  filter:
                    bulbGlowStrength > 0
                      ? `brightness(${1 + bulbGlowStrength * 0.55}) saturate(${1 + bulbGlowStrength * 0.85}) drop-shadow(0 0 ${2 + bulbGlowStrength * 26}px rgba(255, ${bulbGlowGreen}, ${bulbGlowBlue}, ${bulbGlowStrength * 0.9}))`
                      : "none",
                }}
              />
              <svg
                className="fs-circuit-bulb-filament-glow"
                viewBox="0 0 80 108"
                aria-hidden="true"
                style={{
                  opacity: bulbGlowStrength,
                  filter: `drop-shadow(0 0 ${2 + bulbGlowStrength * 15}px rgba(255, ${filamentAuraGreen}, ${filamentAuraBlue}, ${bulbGlowStrength}))`,
                }}
              >
                <path
                  className="fs-filament-aura"
                  d="M 22 45 L 26 40 L 30 50 L 34 40 L 38 50 L 42 40 L 46 50 L 50 40 L 54 50 L 58 45"
                />
                <path
                  className="fs-filament-core"
                  d="M 22 45 L 26 40 L 30 50 L 34 40 L 38 50 L 42 40 L 46 50 L 50 40 L 54 50 L 58 45"
                />
              </svg>
            </div>

            <div
              className={`fs-flow-directions${hasTerminalPolarity ? "" : " is-stopped"}`}
              style={{
                left: `${(MICROSCOPIC_FRAME_RENDER.x / WIDTH) * 100}%`,
                top: `${((MICROSCOPIC_FRAME_RENDER.y + MICROSCOPIC_FRAME_RENDER.height + 4) / HEIGHT) * 100}%`,
                width: `${(MICROSCOPIC_FRAME_RENDER.width / WIDTH) * 100}%`,
              }}
              aria-label={
                hasTerminalPolarity
                  ? `Through the filament, current flows ${currentFlowDirection} and electrons flow ${electronFlowDirection}`
                  : "At zero volts, there is no net current or electron flow through the filament"
              }
            >
              <div className="fs-flow-heading">FLOW THROUGH FILAMENT</div>
              <div className="fs-flow-row fs-current-flow">
                <span>Current flow</span>
                {hasTerminalPolarity ? (
                  <svg
                    className={`fs-flow-arrow is-${currentFlowDirection}`}
                    viewBox="0 0 104 14"
                    aria-hidden="true"
                  >
                    <path d="M 4 7 H 98" />
                    <path d="M 90 1.5 L 98 7 L 90 12.5" />
                  </svg>
                ) : (
                  <span className="fs-no-flow">No net flow</span>
                )}
              </div>
              <div className="fs-flow-row fs-electron-flow">
                <span>Electron flow</span>
                {hasTerminalPolarity ? (
                  <svg
                    className={`fs-flow-arrow is-${electronFlowDirection}`}
                    viewBox="0 0 104 14"
                    aria-hidden="true"
                  >
                    <path d="M 4 7 H 98" />
                    <path d="M 90 1.5 L 98 7 L 90 12.5" />
                  </svg>
                ) : (
                  <span className="fs-no-flow">No net flow</span>
                )}
              </div>
            </div>

            <div
              className="fs-terminal-directions"
              aria-label={
                hasTerminalPolarity
                  ? `The ${leftTerminalPolarity} terminal is to the left and the ${rightTerminalPolarity} terminal is to the right`
                  : "At zero volts, neither terminal has polarity"
              }
              style={{
                left: `${(MICROSCOPIC_FRAME_RENDER.x / WIDTH) * 100}%`,
                top: `${(IV_PANEL_Y / HEIGHT) * 100}%`,
                width: `${(MICROSCOPIC_FRAME_RENDER.width / WIDTH) * 100}%`,
              }}
            >
              <span className={`is-${leftTerminalPolarity}`}>
                ← {hasTerminalPolarity ? `${leftTerminalPolarity} terminal` : "terminal"}
              </span>
              <span className={`is-${rightTerminalPolarity}`}>
                {hasTerminalPolarity ? `${rightTerminalPolarity} terminal` : "terminal"} →
              </span>
            </div>

            <svg
              className="fs-zoom-leaders"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                className="fs-zoom-wedge"
                d={`M ${ZOOM_SOURCE.x} ${ZOOM_SOURCE.y} L ${MICROSCOPIC_FRAME_RENDER.x + ZOOM_TARGET_OVERLAP} ${MICROSCOPIC_FRAME_RENDER.y + ZOOM_TARGET_TOP_INSET} L ${MICROSCOPIC_FRAME_RENDER.x + ZOOM_TARGET_OVERLAP} ${MICROSCOPIC_FRAME_RENDER.y + MICROSCOPIC_FRAME_RENDER.height - ZOOM_TARGET_BOTTOM_INSET} Z`}
              />
              <path
                d={`M ${ZOOM_SOURCE.x} ${ZOOM_SOURCE.y} L ${MICROSCOPIC_FRAME_RENDER.x + ZOOM_TARGET_OVERLAP} ${MICROSCOPIC_FRAME_RENDER.y + ZOOM_TARGET_TOP_INSET}`}
              />
              <path
                d={`M ${ZOOM_SOURCE.x} ${ZOOM_SOURCE.y} L ${MICROSCOPIC_FRAME_RENDER.x + ZOOM_TARGET_OVERLAP} ${MICROSCOPIC_FRAME_RENDER.y + MICROSCOPIC_FRAME_RENDER.height - ZOOM_TARGET_BOTTOM_INSET}`}
              />
              <circle cx={ZOOM_SOURCE.x} cy={ZOOM_SOURCE.y} r="10" />
            </svg>

            <button
              type="button"
              className={`fs-trend-overlay-toggle${showTrendOverlay ? " is-active" : ""}`}
              style={{
                left: `${((ANALYSIS_X + ANALYSIS_WIDTH - 56) / WIDTH) * 100}%`,
                top: `${((IV_PANEL_Y + 6) / HEIGHT) * 100}%`,
              }}
              aria-pressed={showTrendOverlay}
              onClick={() => setShowTrendOverlay((value) => !value)}
            >
              Trend overlay
            </button>

            <div
              className="fs-history-toggle"
              style={{
                left: `${((ANALYSIS_X + ANALYSIS_WIDTH - 5) / WIDTH) * 100}%`,
                top: `${((IV_PANEL_Y + 5) / HEIGHT) * 100}%`,
              }}
            >
              <MinimiseButton
                minimised={ivGraphMinimised}
                onClick={() => setIvGraphMinimised((value) => !value)}
                label="I-V graph"
              />
            </div>

            <div
              className="fs-history-toggle"
              style={{
                left: `${((ANALYSIS_X + ANALYSIS_WIDTH - 5) / WIDTH) * 100}%`,
                top: `${((historyPanelTop(ivGraphMinimised) + 5) / HEIGHT) * 100}%`,
              }}
            >
              <MinimiseButton
                minimised={currentHistoryMinimised}
                onClick={() => setCurrentHistoryMinimised((value) => !value)}
                label="current time series"
              />
            </div>

            <div
              className="fs-stage-instruments"
              aria-label="Simulation instruments"
              style={{
                top: `${(instrumentPanelTop(ivGraphMinimised, currentHistoryMinimised) / HEIGHT) * 100}%`,
              }}
            >
              <AnalogAmmeter
                current={readout.current}
                minimised={analogueMeterMinimised}
                onToggleMinimise={() =>
                  setAnalogueMeterMinimised((value) => !value)
                }
              />

              <div className="fs-stage-readouts">
                <ReadoutCard
                  label="Digital ammeter"
                  value={`${readout.current.toFixed(simplifiedMode ? 2 : 1)} A`}
                  detail="5 s rolling average"
                  minimised={digitalCurrentMinimised}
                  onToggleMinimise={() =>
                    setDigitalCurrentMinimised((value) => !value)
                  }
                />
                <ReadoutCard
                  label="Resistance"
                  value={
                    readout.resistance === null
                      ? "— Ω"
                      : `${readout.resistance.toFixed(1)} Ω`
                  }
                  detail="R = V ÷ I"
                  minimised={resistanceMinimised}
                  onToggleMinimise={() =>
                    setResistanceMinimised((value) => !value)
                  }
                />
              </div>

              <TemperatureReadout
                temperature={readout.temperature}
                minimised={temperatureMinimised}
                onToggleMinimise={() =>
                  setTemperatureMinimised((value) => !value)
                }
              />
            </div>
          </div>
        </section>

      </main>

      {showIVGraphExplanation && (
        <div
          className="fs-circuit-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowIVGraphExplanation(false);
            }
          }}
        >
          <div
            className="fs-circuit-modal fs-density-modal fs-iv-explanation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fs-iv-explanation-modal-title"
          >
            <div className="fs-circuit-modal-header">
              <h2 id="fs-iv-explanation-modal-title">
                I-V graph explanation
              </h2>
              <button
                type="button"
                className="fs-circuit-modal-close"
                onClick={() => setShowIVGraphExplanation(false)}
                aria-label="Close I-V graph explanation"
                title="Close"
              >
                ×
              </button>
            </div>

            <div
              className="fs-density-modal-body fs-iv-explanation-modal-body"
              tabIndex={0}
              aria-label="I-V graph explanation content"
              onWheel={(event) => {
                const panel = event.currentTarget;
                if (panel.scrollHeight > panel.clientHeight) {
                  event.preventDefault();
                  event.stopPropagation();
                  panel.scrollTop += event.deltaY;
                }
              }}
              onKeyDown={(event) => {
                const panel = event.currentTarget;
                const pageStep = panel.clientHeight * 0.85;
                const keySteps = {
                  ArrowDown: 36,
                  ArrowUp: -36,
                  PageDown: pageStep,
                  PageUp: -pageStep,
                  Home: -panel.scrollHeight,
                  End: panel.scrollHeight,
                };
                if (Object.hasOwn(keySteps, event.key)) {
                  event.preventDefault();
                  panel.scrollTop += keySteps[event.key];
                }
              }}
            >
              <p>
                An I-V characteristic shows how the current through a component
                changes as the potential difference across it changes. Potential
                difference is plotted on the horizontal axis in volts (V), and
                current is plotted on the vertical axis in amperes (A).
              </p>
              <p>
                Set a potential difference, wait for the current to settle, and
                capture the reading. Repeating this at several positive and
                negative voltages builds the characteristic curve.
              </p>
              <p>
                At lower voltages, the filament is cooler and its resistance
                changes relatively little, so the graph is approximately a
                straight line. At higher voltages, the current heats the
                filament. Its ions vibrate more, causing more collisions with
                the moving electrons, so the resistance increases. The current
                still rises, but by a smaller amount for each extra volt, making
                the graph curve and become less steep.
              </p>
              <p>
                For any captured point, resistance can be calculated using
                R = V ÷ I. Because this graph plots current against voltage, a
                shallower gradient indicates a higher resistance.
              </p>

              <h3>Summary</h3>
              <ul>
                <li>Potential difference (V) is on the horizontal axis.</li>
                <li>Current (A) is on the vertical axis.</li>
                <li>The curve passes through the origin and is roughly symmetrical.</li>
                <li>A hotter filament has a greater resistance.</li>
                <li>Greater resistance makes the I-V curve less steep.</li>
                <li>Let each current reading settle before capturing it.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function MinimiseButton({ minimised, onClick, label }) {
  return (
    <button
      type="button"
      className="fs-minimise-button"
      onClick={onClick}
      aria-label={`${minimised ? "Expand" : "Minimise"} ${label}`}
      title={`${minimised ? "Expand" : "Minimise"} ${label}`}
      style={{
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: 7,
        border: "1px solid #c4ced6",
        background: "#ffffff",
        color: "#4d5b66",
        fontSize: 18,
        fontWeight: 800,
        lineHeight: 1,
        cursor: "pointer",
        flex: "0 0 auto",
      }}
    >
      {minimised ? "+" : "−"}
    </button>
  );
}

function AnalogAmmeter({ current, minimised, onToggleMinimise }) {
  const clampedCurrent = Math.max(-5, Math.min(5, current));
  const angle = -62 + ((clampedCurrent + 5) / 10) * 124;
  const angleRad = (angle * Math.PI) / 180;
  const cx = 180;
  const cy = 166;
  const needleLength = 108;
  const needleX = cx + Math.sin(angleRad) * needleLength;
  const needleY = cy - Math.cos(angleRad) * needleLength;

  const ticks = [];
  for (let i = 0; i <= 20; i += 1) {
    const value = -5 + i * 0.5;
    const tickAngle = -62 + (i / 20) * 124;
    const rad = (tickAngle * Math.PI) / 180;
    const major = i % 5 === 0;
    const outer = 126;
    const inner = major ? 108 : 117;
    ticks.push({
      value,
      major,
      x1: cx + Math.sin(rad) * inner,
      y1: cy - Math.cos(rad) * inner,
      x2: cx + Math.sin(rad) * outer,
      y2: cy - Math.cos(rad) * outer,
      angle: tickAngle,
    });
  }

  const labels = [-5, -2.5, 0, 2.5, 5];

  return (
    <div
      className={`fs-instrument-card fs-analogue-card${minimised ? " fs-collapsed" : ""}`}
      style={{
        background: minimised ? "#ffffff" : "#fbfaf5",
        border: minimised ? "1px solid #d6dee5" : "1px solid #c8c3b5",
        borderRadius: 12,
        padding: minimised ? "8px 10px" : "10px 10px 8px",
        minHeight: minimised ? 36 : "auto",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          minHeight: 18,
          paddingRight: 28,
        }}
      >
        <div
          style={{
            fontSize: minimised ? 11 : 12,
            color: minimised ? "#687782" : "#5c584e",
            fontWeight: minimised ? 700 : 800,
            letterSpacing: minimised ? 0 : "0.04em",
            whiteSpace: "nowrap",
            transform: minimised ? undefined : "translateX(8px)",
          }}
        >
          {minimised ? "Analogue ammeter" : "ANALOGUE AMMETER"}
        </div>
      </div>

      <div className="fs-instrument-toggle">
        <MinimiseButton
          minimised={minimised}
          onClick={onToggleMinimise}
          label="analogue ammeter"
        />
      </div>

      {!minimised && (
        <svg
          viewBox="0 0 360 190"
          role="img"
          aria-label={`Analogue ammeter reading ${current.toFixed(2)} amperes`}
          style={{
            display: "block",
            width: "100%",
            height: 108,
            marginTop: 0,
            overflow: "visible",
          }}
        >
          <defs>
            <linearGradient id="ammeter-face" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fffef8" />
              <stop offset="100%" stopColor="#f2eee1" />
            </linearGradient>
          </defs>

          <g transform="translate(0 -29)">
          <path
            d="M 34 164 A 146 130 0 0 1 326 164 L 326 184 L 34 184 Z"
            fill="url(#ammeter-face)"
            stroke="#8c8678"
            strokeWidth="3"
          />

          {ticks.map((tick, index) => (
            <line
              key={index}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke="#252525"
              strokeWidth={tick.major ? 3.5 : 1.8}
              strokeLinecap="round"
            />
          ))}

          {labels.map((value) => {
            const labelAngle = -62 + ((value + 5) / 10) * 124;
            const rad = (labelAngle * Math.PI) / 180;
            const radius = 92;
            const x = cx + Math.sin(rad) * radius;
            const y = cy - Math.cos(rad) * radius;
            return (
              <text
                key={value}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="20"
                fontWeight="800"
                fontFamily="Arial, Helvetica, sans-serif"
                fill="#171717"
                stroke="#fffef8"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {value === 0 ? "0" : value.toFixed(value % 1 === 0 ? 0 : 1)}
              </text>
            );
          })}

          <text
            x="180"
            y="119"
            textAnchor="middle"
            fontSize="21"
            fontWeight="800"
            fontFamily="Arial, Helvetica, sans-serif"
            fill="#2d2d2d"
          >
            A
          </text>

          <line
            x1={cx}
            y1={cy}
            x2={needleX}
            y2={needleY}
            stroke="#b3261e"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle cx={cx} cy={cy} r="13" fill="#2a2a2a" />
          <circle cx={cx} cy={cy} r="5" fill="#d7d1c1" />
          </g>

        </svg>
      )}
    </div>
  );
}


function Thermometer({ temperature }) {
  const minTemp = 20;
  const maxTemp = 2000;
  const clamped = Math.max(minTemp, Math.min(maxTemp, temperature));
  const fraction = (clamped - minTemp) / (maxTemp - minTemp);
  const fillHeight = 126 * fraction;
  const fillY = 144 - fillHeight;

  return (
    <svg
      viewBox="0 0 96 172"
      role="img"
      aria-label={`Thermometer reading ${temperature.toFixed(0)} degrees Celsius`}
      style={{
        width: 42,
        height: 114,
        display: "block",
        flex: "0 0 auto",
      }}
    >
      <rect
        x="7"
        y="12"
        width="18"
        height="136"
        rx="9"
        fill="#f7f9fa"
        stroke="#78858e"
        strokeWidth="3"
      />
      <rect
        x="12"
        y={fillY}
        width="8"
        height={fillHeight}
        rx="4"
        fill="#d83b2d"
      />
      <circle
        cx="16"
        cy="148"
        r="17"
        fill="#d83b2d"
        stroke="#78858e"
        strokeWidth="3"
      />
      <circle cx="16" cy="148" r="9" fill="#f45a45" />

      {[20, 500, 1000, 1500, 2000].map((value) => {
        const tickFraction = (value - minTemp) / (maxTemp - minTemp);
        const y = 144 - tickFraction * 126;
        return (
          <g key={value}>
            <line
              x1="27"
              y1={y}
              x2="35"
              y2={y}
              stroke="#505d65"
              strokeWidth="2"
            />
            <text
              x="41"
              y={y}
              fontSize="14"
              fontWeight="700"
              dominantBaseline="middle"
              fill="#505d65"
            >
              {value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function TemperatureReadout({
  temperature,
  minimised = false,
  onToggleMinimise = null,
}) {
  return (
    <div
      className={`fs-instrument-card fs-temperature-card${minimised ? " fs-collapsed" : ""}`}
      style={{
        ...readoutCardStyle,
        position: "relative",
        padding: minimised ? "8px 10px" : "10px 12px",
        display: "flex",
        alignItems: minimised ? "stretch" : "center",
        justifyContent: minimised ? "stretch" : "space-between",
        gap: 4,
        overflow: "visible",
        minHeight: minimised ? 36 : 0,
      }}
    >
      <div
        style={{
          minWidth: 0,
          flex: "1 1 auto",
          paddingRight: onToggleMinimise ? 10 : 0,
          alignSelf: minimised ? "auto" : "flex-start",
          paddingTop: minimised ? 0 : 2,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: "#687782",
            fontWeight: 700,
            lineHeight: 1.05,
            transform: minimised ? undefined : "translateY(10px)",
          }}
        >
          <span style={{ display: "block" }}>Filament</span>
          <span style={{ display: "block" }}>temperature</span>
        </div>

        {!minimised && (
          <>
            <div
              style={{
                marginTop: 25,
                fontSize: 19,
                fontWeight: 800,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                whiteSpace: "nowrap",
              }}
            >
              {temperature.toFixed(0)} °C
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: "#87939c" }}>
              ambient = 20 °C
            </div>
          </>
        )}
      </div>

      {!minimised && <Thermometer temperature={temperature} />}

      {onToggleMinimise && (
        <div
          className="fs-instrument-toggle"
          style={{}}
        >
          <MinimiseButton
            minimised={minimised}
            onClick={onToggleMinimise}
            label="thermometer"
          />
        </div>
      )}
    </div>
  );
}

function ReadoutCard({
  label,
  value,
  detail,
  minimised = false,
  onToggleMinimise = null,
}) {
  return (
    <div
      className={`fs-instrument-card${minimised ? " fs-collapsed" : ""}`}
      style={{
        ...readoutCardStyle,
        minHeight: minimised ? 36 : readoutCardStyle.minHeight,
        padding: minimised ? "8px 10px" : readoutCardStyle.padding,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          minHeight: 18,
          paddingRight: 28,
        }}
      >
        <div
          style={{
            fontSize: label === "Digital ammeter" ? 9 : 11,
            color: "#687782",
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: label === "Digital ammeter" ? "-0.01em" : 0,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      </div>

      {onToggleMinimise && (
        <div className="fs-instrument-toggle">
          <MinimiseButton
            minimised={minimised}
            onClick={onToggleMinimise}
            label={`${label} digital readout`}
          />
        </div>
      )}

      {!minimised && (
        <>
          <div
            className="fs-readout-value"
            style={{
              marginTop: 5,
              fontSize: 23,
              fontWeight: 800,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "nowrap",
            }}
          >
            {value}
          </div>
          <div
            className="fs-readout-detail"
            style={{ marginTop: 4, fontSize: 11, color: "#87939c" }}
          >
            {detail}
          </div>
        </>
      )}
    </div>
  );
}

const readoutCardStyle = {
  background: "#ffffff",
  border: "1px solid #d6dee5",
  borderRadius: 12,
  padding: "12px 14px",
  minHeight: 76,
};

const buttonStyle = {
  border: "1px solid #b8c3cc",
  background: "#ffffff",
  color: "#26333d",
  borderRadius: 9,
  padding: "9px 14px",
  minHeight: 40,
  fontSize: 13,
  fontWeight: 750,
  cursor: "pointer",
};

const layoutCss = `
  .fs-page,
  .fs-page * {
    box-sizing: border-box;
  }

  .fs-page {
    width: 100%;
    min-height: 100vh;
    min-height: 100svh;
    margin: 0;
    padding: clamp(7px, 0.8vw, 12px) clamp(14px, 2vw, 28px);
    overflow-x: clip;
    background: #dfe5ea;
    color: #1f2933;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
      "Segoe UI", sans-serif;
  }

  .fs-shell {
    width: min(100%, 1680px);
    margin: 0 auto;
    display: grid;
    gap: clamp(5px, 0.55vw, 8px);
  }

  .fs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: clamp(14px, 1.2vw, 18px);
    min-height: 25px;
    padding: 0 2px;
  }

  .fs-header h1 {
    min-width: 0;
    margin: 0;
    font-size: clamp(22px, 1.9vw, 30px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    color: #19324a;
  }

  .fs-header p {
    max-width: 76ch;
    margin: 7px 0 0;
    color: #52606d;
    font-size: clamp(13px, 1vw, 15px);
    line-height: 1.45;
  }

  .fs-header-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    flex: 0 0 auto;
  }

  .fs-simplified-mode-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 4px 8px 4px 6px;
    border: 1px solid #aebdca;
    border-radius: 9px;
    background: rgba(244, 249, 253, 0.94);
    color: #29445a;
    font-size: clamp(9px, 0.68vw, 11px);
    font-weight: 750;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }

  .fs-simplified-mode-toggle input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .fs-simplified-mode-track {
    position: relative;
    flex: 0 0 auto;
    width: 30px;
    height: 17px;
    border: 1px solid #8c9aa6;
    border-radius: 999px;
    background: #cbd4dc;
    transition: background 140ms ease, border-color 140ms ease;
  }

  .fs-simplified-mode-thumb {
    position: absolute;
    left: 2px;
    top: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(31, 50, 65, 0.3);
    transition: transform 140ms ease;
  }

  .fs-simplified-mode-toggle input:checked + .fs-simplified-mode-track {
    border-color: #3e82b9;
    background: #579dd3;
  }

  .fs-simplified-mode-toggle input:checked + .fs-simplified-mode-track .fs-simplified-mode-thumb {
    transform: translateX(13px);
  }

  .fs-simplified-mode-toggle input:focus-visible + .fs-simplified-mode-track {
    outline: 3px solid rgba(77, 143, 200, 0.26);
    outline-offset: 2px;
  }

  .fs-circuit-diagram-button {
    flex: 0 0 auto;
    border: 1px solid #9aa9b5;
    background: #ffffff;
    color: #19324a;
    border-radius: 8px;
    padding: 4px 10px;
    min-height: 27px;
    font-size: 11.5px;
    font-weight: 750;
    cursor: pointer;
  }

  .fs-circuit-diagram-button:hover {
    background: #f3f6f8;
  }

  .fs-circuit-diagram-button:focus-visible,
  .fs-circuit-modal-close:focus-visible {
    outline: 3px solid rgba(25, 50, 74, 0.28);
    outline-offset: 2px;
  }

  .fs-circuit-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(20, 28, 36, 0.58);
  }

  .fs-circuit-modal {
    width: min(92vw, 620px);
    max-height: min(88vh, 720px);
    overflow: hidden;
    border: 1px solid #c7d1d9;
    border-radius: 16px;
    background: #ffffff;
    box-shadow: 0 24px 70px rgba(20, 28, 36, 0.28);
  }

  .fs-circuit-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 14px;
    border-bottom: 1px solid #dbe2e8;
    background: #f7f9fb;
  }

  .fs-circuit-modal-header h2 {
    margin: 0;
    color: #19324a;
    font-size: 17px;
    line-height: 1.2;
  }

  .fs-circuit-modal-close {
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid #bfcbd4;
    border-radius: 8px;
    background: #ffffff;
    color: #465762;
    font-size: 24px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }

  .fs-circuit-modal-body {
    display: grid;
    place-items: center;
    padding: clamp(18px, 3vw, 34px);
    overflow: auto;
    background: #ffffff;
  }

  .fs-circuit-diagram-image {
    display: block;
    width: min(100%, 460px);
    height: auto;
    max-height: 62vh;
    object-fit: contain;
  }

  .fs-density-modal {
    width: min(92vw, 560px);
  }

  .fs-density-modal-body {
    padding: clamp(18px, 2.3vw, 28px);
    color: #344554;
    font-size: clamp(14px, 1vw, 16px);
    line-height: 1.55;
  }

  .fs-density-modal-body p {
    margin: 0 0 12px;
  }

  .fs-density-modal-body p:last-child {
    margin-bottom: 0;
  }

  .fs-iv-explanation-modal {
    display: flex;
    flex-direction: column;
    width: min(92vw, 650px);
    max-height: min(88vh, 720px);
  }

  .fs-iv-explanation-modal-body {
    display: block;
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: #9aa9b5 #eef2f5;
    text-align: left;
  }

  .fs-iv-explanation-modal-body::-webkit-scrollbar {
    width: 10px;
  }

  .fs-iv-explanation-modal-body::-webkit-scrollbar-track {
    background: #eef2f5;
    border-radius: 999px;
  }

  .fs-iv-explanation-modal-body::-webkit-scrollbar-thumb {
    border: 2px solid #eef2f5;
    border-radius: 999px;
    background: #9aa9b5;
  }

  .fs-iv-explanation-modal-body h3 {
    margin: 18px 0 8px;
    color: #19324a;
    font-size: 16px;
  }

  .fs-iv-explanation-modal-body ul {
    margin: 0;
    padding-left: 22px;
  }

  .fs-iv-explanation-modal-body li + li {
    margin-top: 5px;
  }

  .fs-panel,
  .fs-stage-card {
    border: 1px solid #cbd5df;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(31, 41, 51, 0.08);
  }

  .fs-control-panel {
    padding: clamp(14px, 1.35vw, 20px);
    background: #f8fafc;
  }

  .fs-control-layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    align-items: center;
    gap: clamp(16px, 2vw, 30px);
  }

  .fs-voltage-control {
    min-width: 0;
  }

  .fs-voltage-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    font-size: 14px;
  }

  .fs-voltage-value {
    flex: 0 0 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 17px;
    font-weight: 800;
  }

  .fs-voltage-stepper {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 7px;
    margin-top: 7px;
  }

  .fs-voltage-step-button {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid #b8c3cc;
    border-radius: 7px;
    background: #ffffff;
    color: #26333d;
    font-size: 19px;
    font-weight: 800;
    line-height: 1;
    cursor: pointer;
  }

  .fs-voltage-step-button:hover:not(:disabled) {
    background: #eef3f6;
  }

  .fs-voltage-step-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .fs-voltage-step-button:focus-visible {
    outline: 3px solid rgba(25, 50, 74, 0.24);
    outline-offset: 2px;
  }

  .fs-slider-wrap {
    position: relative;
    margin-top: 11px;
    padding-bottom: 22px;
  }

  .fs-slider {
    display: block;
    width: 100%;
    margin: 0;
  }

  .fs-slider-zero-tick {
    position: absolute;
    left: 50%;
    top: 18px;
    width: 2px;
    height: 8px;
    transform: translateX(-50%);
    border-radius: 1px;
    background: #7c8790;
  }

  .fs-slider-zero-label {
    position: absolute;
    left: 50%;
    top: 27px;
    transform: translateX(-50%);
    color: #667581;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }

  .fs-control-detail {
    margin-top: 4px;
    color: #667581;
    font-size: 12px;
  }

  .fs-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .fs-instrument-card {
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
  }

  .fs-analogue-card {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .fs-stage-card {
    position: relative;
    width: 100%;
    overflow: hidden;
    background: #ffffff;
  }

  .fs-stage-controls {
    position: absolute;
    z-index: 4;
    left: 1.875%;
    top: ${(IV_PANEL_Y / HEIGHT) * 100}%;
    width: calc(26.25% + 10px);
    height: 82px;
    box-sizing: border-box;
    padding: 6px 8px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    gap: 5px;
    align-content: center;
    border: 1px solid rgba(203, 213, 223, 0.92);
    border-radius: 10px;
    background: rgba(248, 250, 252, 0.94);
    backdrop-filter: blur(3px);
    box-shadow: 0 3px 10px rgba(31, 41, 51, 0.065);
  }

  .fs-stage-controls .fs-voltage-control {
    display: grid;
    grid-template-columns: 145px 120px;
    align-items: center;
    gap: 8px;
    transform: none;
  }

  .fs-stage-controls .fs-voltage-heading {
    width: 145px;
    justify-content: flex-start;
    gap: 3px;
    font-size: clamp(8px, 0.65vw, 10px);
    white-space: nowrap;
  }

  .fs-stage-controls .fs-voltage-value {
    width: 48px;
    padding: 1px 4px;
    border: 1px solid #9fc5ed;
    border-radius: 4px;
    background: #eaf4ff;
    color: #174f7a;
    font-size: clamp(10px, 0.78vw, 12px);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .fs-stage-controls .fs-slider-wrap {
    width: 64px;
    min-width: 64px;
    max-width: 64px;
    margin-top: 0;
    padding-bottom: 18px;
  }

  .fs-stage-controls .fs-voltage-stepper {
    grid-template-columns: 20px 64px 20px;
    width: 120px;
    margin-top: 0;
    gap: 8px;
  }

  .fs-stage-controls .fs-voltage-stepper .fs-slider-wrap {
    width: 64px;
    min-width: 64px;
    max-width: 64px;
  }

  .fs-stage-controls .fs-slider-wrap::before {
    content: "";
    position: absolute;
    z-index: 0;
    left: 0;
    right: 0;
    top: 6px;
    height: 6px;
    border: 1px solid rgba(82, 103, 120, 0.34);
    border-radius: 999px;
    background: linear-gradient(
      to right,
      #d4dde5 0%,
      #d4dde5 var(--slider-active-start),
      #6ea8dc var(--slider-active-start),
      #6ea8dc var(--slider-active-end),
      #d4dde5 var(--slider-active-end),
      #d4dde5 100%
    );
  }

  .fs-stage-controls .fs-slider-thumb {
    position: absolute;
    z-index: 1;
    left: var(--slider-thumb-position);
    top: 1.5px;
    width: 15px;
    height: 15px;
    transform: translateX(-50%);
    border: 2px solid #4d8fc8;
    border-radius: 50%;
    background: #fafdff;
    box-shadow: 0 1px 3px rgba(31, 50, 65, 0.26);
    pointer-events: none;
  }

  .fs-stage-controls .fs-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    min-width: 0;
    max-width: none;
    height: 32px;
    margin: -6px 0 -8px;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
    touch-action: none;
  }

  .fs-stage-controls .fs-slider::-webkit-slider-runnable-track {
    height: 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
  }

  .fs-stage-controls .fs-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 28px;
    height: 28px;
    margin-top: -11px;
    border: 0;
    background: transparent;
    opacity: 0;
  }

  .fs-stage-controls .fs-slider::-moz-range-track {
    height: 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
  }

  .fs-stage-controls .fs-slider::-moz-range-thumb {
    width: 28px;
    height: 28px;
    border: 0;
    background: transparent;
    opacity: 0;
  }

  .fs-stage-controls .fs-slider:focus-visible {
    outline: 3px solid rgba(77, 143, 200, 0.24);
    outline-offset: 2px;
  }

  .fs-stage-controls .fs-voltage-step-button {
    width: 20px;
    height: 20px;
    font-size: 13px;
    transform: none;
  }

  .fs-stage-controls .fs-slider-zero-tick {
    top: 15px;
    width: 1px;
    height: 4px;
    background: #607484;
  }

  .fs-stage-controls .fs-slider-zero-label {
    top: 19px;
    font-size: 7px;
    line-height: 1;
  }

  .fs-stage-controls .fs-control-detail {
    margin-top: 0;
    font-size: clamp(7px, 0.62vw, 10px);
  }

  .fs-stage-controls .fs-actions {
    display: grid;
    grid-template-columns: 85px 48px 42px minmax(76px, 1fr);
    align-items: center;
    justify-content: stretch;
    gap: 4px;
    min-width: 0;
  }

  .fs-stage-controls .fs-actions button {
    width: 100%;
    min-height: 24px !important;
    white-space: nowrap;
    padding: 3px 5px !important;
    font-size: clamp(8px, 0.61vw, 9.5px) !important;
    border-radius: 6px !important;
  }

  .fs-stage-controls .fs-control-side {
    display: block;
    width: 100%;
    min-width: 0;
    justify-self: stretch;
  }

  .fs-stage-controls .fs-control-side .fs-control-detail {
    margin: 0;
    padding: 0 2px;
    text-align: right;
    white-space: nowrap;
    font-size: clamp(7px, 0.56vw, 9px);
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
  }

  .fs-stage-wrap {
    position: relative;
    width: 100%;
  }

  .fs-stage {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: ${WIDTH} / ${HEIGHT};
  }

  .fs-microscopic-overlay {
    position: absolute;
    z-index: 2;
    inset: 0;
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: ${WIDTH} / ${HEIGHT};
    pointer-events: none;
  }

  .fs-circuit-context-image {
    position: absolute;
    z-index: 2;
    left: calc(4.0625% + ${(MACRO_VIEW_OFFSET_X / WIDTH) * 100}%);
    top: calc(37.24% + ${(MACRO_VIEW_OFFSET_Y / HEIGHT) * 100}% + 5px);
    width: 22.5%;
    height: auto;
    pointer-events: none;
    user-select: none;
  }

  .fs-circuit-bulb {
    position: absolute;
    z-index: 3;
    left: calc(11.5625% + ${(MACRO_VIEW_OFFSET_X / WIDTH) * 100}%);
    top: calc(24.07% + ${(MACRO_VIEW_OFFSET_Y / HEIGHT) * 100}%);
    width: 9.375%;
    height: auto;
    pointer-events: none;
    user-select: none;
  }

  .fs-circuit-bulb-glow {
    position: absolute;
    z-index: 0;
    inset: -34% -64% -2%;
    border-radius: 50%;
    background: radial-gradient(
      circle at 50% 48%,
      rgba(255, var(--bulb-core-green), var(--bulb-core-blue), 1) 0%,
      rgba(255, var(--bulb-glow-green), var(--bulb-glow-blue), 0.92) 24%,
      rgba(255, var(--bulb-outer-green), var(--bulb-outer-blue), 0.55) 51%,
      rgba(255, var(--bulb-outer-green), var(--bulb-outer-blue), 0.2) 72%,
      rgba(255, var(--bulb-outer-green), var(--bulb-outer-blue), 0) 100%
    );
    filter: blur(14px);
    transform-origin: 50% 48%;
    transition: opacity 120ms linear, transform 120ms linear;
  }

  .fs-circuit-bulb-glow::after {
    content: "";
    position: absolute;
    inset: 24% 31% 35%;
    border-radius: 50%;
    background: rgba(255, var(--bulb-core-green), var(--bulb-core-blue), 0.98);
    filter: blur(7px);
  }

  .fs-circuit-bulb-image {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: auto;
    transition: filter 120ms linear;
  }

  .fs-circuit-bulb-filament-glow {
    position: absolute;
    z-index: 2;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    transition: opacity 120ms linear, filter 120ms linear;
  }

  .fs-circuit-bulb-filament-glow path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .fs-circuit-bulb-filament-glow .fs-filament-aura {
    stroke: rgba(255, var(--filament-aura-green), var(--filament-aura-blue), 0.88);
    stroke-width: 8;
  }

  .fs-circuit-bulb-filament-glow .fs-filament-core {
    stroke: rgb(255, var(--filament-core-green), var(--filament-core-blue));
    stroke-width: 3.1;
  }

  .fs-flow-directions {
    position: absolute;
    z-index: 4;
    box-sizing: border-box;
    padding: 5px 7px 6px;
    border: 1px solid rgba(165, 181, 194, 0.8);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 4px 12px rgba(31, 50, 65, 0.08);
    pointer-events: none;
  }

  .fs-flow-heading {
    margin-bottom: 3px;
    color: #536675;
    font: 800 7px/1 system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-align: center;
  }

  .fs-flow-row {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    min-height: 15px;
    font: 750 9px/1 system-ui, sans-serif;
  }

  .fs-flow-row + .fs-flow-row {
    margin-top: 1px;
  }

  .fs-current-flow {
    color: #a7195b;
  }

  .fs-electron-flow {
    color: #1679a8;
  }

  .fs-flow-arrow {
    display: block;
    width: 100%;
    height: 14px;
    overflow: visible;
    transform-origin: center;
  }

  .fs-flow-arrow.is-left {
    transform: scaleX(-1);
  }

  .fs-flow-arrow path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .fs-no-flow {
    color: #758692;
    font-size: 8px;
    font-weight: 700;
    text-align: center;
  }

  .fs-flow-directions.is-stopped .fs-flow-row {
    color: #758692;
  }

  .fs-terminal-directions {
    position: absolute;
    z-index: 4;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 22px;
    padding: 4px 7px;
    border: 1px solid rgba(164, 179, 191, 0.72);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 3px 9px rgba(31, 50, 65, 0.08);
    color: #52636f;
    font: 750 8px/1 system-ui, sans-serif;
    letter-spacing: 0.01em;
    pointer-events: none;
    white-space: nowrap;
  }

  .fs-terminal-directions .is-positive {
    color: #9f1657;
  }

  .fs-terminal-directions .is-negative {
    color: #274c69;
  }

  .fs-terminal-directions .is-neutral {
    color: #64747f;
  }

  .fs-zoom-leaders {
    position: absolute;
    z-index: 1;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .fs-zoom-leaders path {
    fill: none;
    stroke: #a7195b;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .fs-zoom-leaders .fs-zoom-wedge {
    fill: rgba(185, 48, 72, 0.075);
    stroke: none;
  }

  .fs-zoom-leaders circle {
    fill: rgba(167, 25, 91, 0.12);
    stroke: #a7195b;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .fs-trend-overlay-toggle {
    position: absolute;
    z-index: 4;
    height: 18px;
    padding: 0 8px;
    border: 1px solid #8d78b8;
    border-radius: 5px;
    background: #ffffff;
    color: #5b3e97;
    font: 700 9px/1 system-ui, sans-serif;
    cursor: pointer;
    white-space: nowrap;
    transform: translateX(-100%);
  }

  .fs-trend-overlay-toggle.is-active {
    background: #5b3e97;
    color: #ffffff;
  }

  .fs-trend-overlay-toggle:focus-visible {
    outline: 2px solid #8fc2f7;
    outline-offset: 2px;
  }


  .fs-history-toggle {
    position: absolute;
    z-index: 4;
    width: 18px;
    height: 18px;
    transform: translateX(-100%);
  }

  .fs-history-toggle .fs-minimise-button {
    width: 18px !important;
    height: 18px !important;
    min-width: 18px !important;
    min-height: 18px !important;
    padding: 0 !important;
    border: 1px solid #c4ced6 !important;
    border-radius: 5px !important;
    background: #ffffff !important;
    color: #4d5b66 !important;
    font-size: 12px !important;
    font-weight: 800 !important;
    line-height: 1 !important;
    display: grid !important;
    place-items: center !important;
  }

  .fs-stage-instruments {
    position: absolute;
    left: ${(ANALYSIS_X / WIDTH) * 100}%;
    width: ${(ANALYSIS_WIDTH / WIDTH) * 100}%;
    height: ${(INSTRUMENT_PANEL_HEIGHT / HEIGHT) * 100}%;
    box-sizing: border-box;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.82fr) minmax(0, 1.1fr);
    gap: clamp(4px, 0.4vw, 7px);
    align-items: stretch;
    overflow: visible;
  }

  .fs-stage-instruments .fs-instrument-card {
    position: relative;
    border-radius: clamp(6px, 0.6vw, 10px) !important;
    padding: clamp(3px, 0.3vw, 5px) !important;
    min-height: 0 !important;
    box-sizing: border-box !important;
  }

  .fs-stage-instruments .fs-instrument-toggle {
    position: absolute;
    top: 5px;
    right: 5px;
    z-index: 3;
    width: 18px;
    height: 18px;
  }

  .fs-stage-instruments .fs-instrument-card:not(.fs-collapsed) {
    height: 100% !important;
  }

  .fs-stage-instruments .fs-instrument-card.fs-collapsed {
    height: clamp(30px, 2.6vw, 36px) !important;
    min-height: clamp(30px, 2.6vw, 36px) !important;
    align-self: start;
    overflow: hidden;
    padding: clamp(4px, 0.32vw, 6px) !important;
  }

  .fs-stage-instruments .fs-instrument-card.fs-collapsed > div:first-child {
    width: 100%;
    height: 100%;
    min-height: 0 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 8px !important;
  }

  .fs-stage-instruments .fs-instrument-card.fs-collapsed > div:first-child > div:first-child {
    font-size: clamp(10px, 0.75vw, 12px) !important;
    line-height: 1.05 !important;
    font-weight: 700 !important;
    color: #687782 !important;
    letter-spacing: 0 !important;
    white-space: nowrap !important;
  }

  .fs-stage-instruments .fs-instrument-card > div:first-child {
    font-size: clamp(8px, 0.62vw, 10px) !important;
    gap: 4px !important;
  }

  .fs-stage-instruments .fs-minimise-button {
    width: 18px !important;
    height: 18px !important;
    min-width: 18px !important;
    min-height: 18px !important;
    padding: 0 !important;
    border: 1px solid #c4ced6 !important;
    border-radius: 5px !important;
    background: #ffffff !important;
    color: #4d5b66 !important;
    font-size: 12px !important;
    font-weight: 800 !important;
    line-height: 1 !important;
    display: grid !important;
    place-items: center !important;
  }

  .fs-stage-instruments .fs-analogue-card > div:first-child,
  .fs-stage-instruments .fs-instrument-card > div:first-child {
    min-width: 0;
  }

  .fs-stage-instruments .fs-analogue-card > div:first-child > div:first-child {
    font-size: clamp(8px, 0.62vw, 10px) !important;
    letter-spacing: 0.025em !important;
    white-space: nowrap;
  }

  .fs-stage-instruments .fs-analogue-card:not(.fs-collapsed) {
    padding-inline: 0 !important;
  }

  .fs-stage-instruments .fs-analogue-card svg {
    width: 110% !important;
    height: auto !important;
    min-height: 0;
    flex: 1 1 auto;
    max-height: 114px;
    margin-top: 2px !important;
    transform: translateX(-4.55%);
  }

  .fs-stage-readouts {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: repeat(2, minmax(0, 1fr));
    gap: clamp(3px, 0.3vw, 5px);
  }

  .fs-stage-instruments .fs-stage-readouts .fs-instrument-card {
    overflow: hidden;
  }

  .fs-stage-instruments .fs-stage-readouts .fs-instrument-card:not(.fs-collapsed) {
    min-height: 0 !important;
    height: 100% !important;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    padding-top: clamp(3px, 0.26vw, 4px) !important;
    padding-bottom: clamp(3px, 0.26vw, 4px) !important;
  }

  .fs-stage-instruments .fs-stage-readouts .fs-readout-value {
    margin-top: 2px !important;
    font-size: clamp(11px, 0.9vw, 15px) !important;
    line-height: 1.05 !important;
  }

  .fs-stage-instruments .fs-stage-readouts .fs-readout-detail {
    margin-top: 1px !important;
    font-size: clamp(7px, 0.52vw, 9px) !important;
    line-height: 1.05 !important;
    white-space: nowrap;
  }

  .fs-stage-instruments > .fs-instrument-card:last-child {
    align-self: stretch;
    min-width: 0;
    min-height: 0;
    width: 100%;
    overflow: visible;
    padding-inline: clamp(3px, 0.26vw, 5px) !important;
  }

  .fs-stage-instruments > .fs-instrument-card:last-child svg {
    width: clamp(56px, 4.6vw, 72px) !important;
    height: auto !important;
    max-height: 120px;
    flex: 0 1 120px;
    transform: translate(-15px, 4px);
    overflow: visible;
  }

  .fs-stage-instruments > .fs-instrument-card:last-child > div > div:nth-child(2) {
    font-size: clamp(11px, 0.95vw, 15px) !important;
    line-height: 1.05 !important;
  }

  .fs-stage-instruments > .fs-instrument-card:last-child > div > div:nth-child(3) {
    font-size: clamp(6px, 0.5vw, 8px) !important;
    line-height: 1.1 !important;
  }

  .fs-status {
    display: flex;
    justify-content: space-between;
    gap: 10px 18px;
    flex-wrap: wrap;
    padding: 0 2px 2px;
    color: #5b6872;
    font-size: 12px;
    line-height: 1.4;
  }

  @media (max-width: 820px) {
    .fs-header {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .fs-header-actions {
      flex-wrap: wrap;
    }

    .fs-circuit-diagram-button {
      min-height: 34px;
    }

    .fs-circuit-modal-backdrop {
      padding: 12px;
    }

    .fs-circuit-modal {
      width: min(96vw, 620px);
    }

    .fs-control-layout {
      grid-template-columns: 1fr;
    }

    .fs-actions {
      justify-content: flex-start;
    }

    .fs-stage-controls {
      position: static;
      width: auto;
      height: auto;
      margin: 10px;
      padding: 10px 12px;
      grid-template-columns: 1fr;
      box-shadow: none;
      backdrop-filter: none;
    }

    .fs-stage-controls .fs-slider-wrap {
      width: 100%;
      min-width: 0;
    }

    .fs-stage-controls .fs-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      justify-content: stretch;
      min-width: 0;
    }

    .fs-stage-controls .fs-control-side {
      width: 100%;
    }

    .fs-stage-controls .fs-control-side .fs-control-detail {
      text-align: left;
      white-space: normal;
    }
  }

  @media (max-width: 680px) {
    .fs-page {
      padding: 10px;
    }

    .fs-shell {
      gap: 10px;
    }

    .fs-actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .fs-actions button {
      width: 100%;
    }
  }

  @media (max-width: 680px) {
    .fs-stage-controls .fs-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .fs-stage-controls .fs-actions button {
      width: 100%;
      padding-inline: 6px !important;
    }

  }
`;
