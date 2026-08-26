import { useEffect, useRef, useState } from "react";
import circuitDiagram from "./assets/circuit-diagram.svg";

// The canvas is a single responsive stage. Its CSS size may change, but these
// internal coordinates stay fixed so every drawn element scales together.
const WIDTH = 1600;
const HEIGHT = 920;
const CANVAS_RENDER_SCALE = 2;

// The particle apparatus is rendered as one uniformly-scaled object. Physics
// coordinates and the relative dimensions of reservoir / filament / sink / ions
// remain unchanged.
const PARTICLE_VIEW_SCALE = 0.79;
const PARTICLE_VIEW_OFFSET_X = 108;
const PARTICLE_VIEW_OFFSET_Y = 76; // fitted and centred in the left simulation pane

// Shared analysis-column geometry. Keeping these in one place prevents the
// I-V and time-series panels drifting to unrelated widths and margins.
const ANALYSIS_X = 920;
const ANALYSIS_WIDTH = 650; // shared width for I-V, current history, and instrument panel
const IV_PANEL_WIDTH = ANALYSIS_WIDTH; // all analysis panels now share the same width
const IV_PANEL_Y = 29;
const IV_PANEL_HEIGHT = 491;
const IV_PANEL_COLLAPSED_HEIGHT = 42;
const HISTORY_PANEL_Y = 502;
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
const MAX_VOLTAGE = 12;
const MAX_RESERVOIR_ELECTRONS = 1382; // 96% of 1440 to preserve density in 0.96x chamber area
const MAX_TOTAL_ELECTRONS = 2700;

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
const AMMETER_HISTORY_SAMPLE_MS = 250;

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
const SIMULATION_LABEL_FONT_SIZE = Math.round(17 * 1.1);
const SIMULATION_DETAIL_FONT_SIZE = Math.round(11 * 1.1);
const SIMULATION_DIRECTION_FONT_SIZE = Math.round(12 * 1.1);
const ION_TEMPERATURE_LABEL_FONT_SIZE = Math.round(
  SIMULATION_DETAIL_FONT_SIZE * 1.5
);

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
  // Positive p.d. drives representative electrons left-to-right. Negative p.d.
  // swaps the reservoir and sink, so the flow direction becomes right-to-left.
  return potentialDifference < 0 ? -1 : 1;
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

function voltageToTargetCount(voltage) {
  // Electron density represents the magnitude of the potential difference.
  // The sign selects which side acts as the source reservoir.
  return Math.round(
    Math.sqrt(Math.abs(voltage) / MAX_VOLTAGE) * MAX_RESERVOIR_ELECTRONS
  );
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

function drawTerminalPositiveIonLattice(ctx, chamber) {
  // Keep the terminal ions slightly smaller and closer together than the
  // filament lattice so four decorative columns fit comfortably.
  const visualRadius = ION_RADIUS * 1.65;
  const edgeInset = 14;
  const filamentRowCount = 12;
  const rowSpacing =
    (FILAMENT.height - edgeInset * 2) / (filamentRowCount - 0.5);

  const left = chamber.x + 30;
  const right = chamber.x + chamber.width - 30;
  const top = chamber.y + edgeInset;
  const bottom = chamber.y + chamber.height - edgeInset;
  const columnCount = 4;
  const columnSpacing = (right - left) / (columnCount - 1);

  ctx.save();

  // Keep the decorative lattice entirely inside the rounded terminal chamber.
  drawRoundedRect(
    ctx,
    chamber.x,
    chamber.y,
    chamber.width,
    chamber.height,
    18
  );
  ctx.clip();

  for (let column = 0; column < columnCount; column += 1) {
    const x = left + column * columnSpacing;
    const staggerY = column % 2 === 1 ? rowSpacing * 0.5 : 0;

    for (
      let y = top + staggerY;
      y <= bottom + 0.001;
      y += rowSpacing
    ) {
      // A soft, static cool-ion treatment keeps these in the background.
      const g = ctx.createRadialGradient(
        x - visualRadius * 0.32,
        y - visualRadius * 0.32,
        visualRadius * 0.12,
        x,
        y,
        visualRadius
      );
      g.addColorStop(0, "rgba(210, 217, 223, 0.30)");
      g.addColorStop(0.42, "rgba(135, 145, 154, 0.22)");
      g.addColorStop(1, "rgba(69, 78, 87, 0.16)");

      ctx.beginPath();
      ctx.arc(x, y, visualRadius, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.fillStyle = "rgba(52, 62, 72, 0.38)";
      ctx.font = `800 ${Math.round(visualRadius * 1.02)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("+", x, y + 0.5);
    }
  }

  ctx.restore();
}

function ionVibrationAmplitude(tempC) {
  const excess = Math.max(0, tempC - AMBIENT_TEMP);

  // Visual-only vibration. Keep the shake readable at high temperature without
  // affecting the larger invisible collision radius used by the physics.
  return 0.35 + Math.min(4.0, Math.sqrt(excess) * 0.10);
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

function positionIsClear(x, y, electrons, minimumSpacing = 11) {
  const minimumSpacing2 = minimumSpacing * minimumSpacing;
  for (const other of electrons) {
    const dx = other.x - x;
    const dy = other.y - y;
    if (dx * dx + dy * dy < minimumSpacing2) return false;
  }
  return true;
}

function spawnOneElectron(electrons, potentialDifference) {
  const sourceRect = sourceRectFor(potentialDifference);

  const left = sourceRect.x + WALL_BUFFER + 5;
  const right = sourceRect.x + sourceRect.width - WALL_BUFFER - 5;
  const top = sourceRect.y + WALL_BUFFER + 5;
  const bottom = sourceRect.y + sourceRect.height - WALL_BUFFER - 5;

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const x = left + Math.random() * Math.max(1, right - left);
    const y = top + Math.random() * Math.max(1, bottom - top);

    if (!insideAllowedRegion(x, y)) continue;
    if (!positionIsClear(x, y, electrons)) continue;

    electrons.push(new Electron(x, y));
    return true;
  }

  return false;
}

function rebuildReservoirPopulation(electrons, targetCount, potentialDifference) {
  const sourceRect = sourceRectFor(potentialDifference);

  // Keep conductor electrons and anything outside the current source chamber,
  // but replace the complete source-reservoir population on every slider change.
  const retained = electrons.filter(
    (electron) => !inSourceReservoir(electron, potentialDifference)
  );

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
    Math.max(0, MAX_TOTAL_ELECTRONS - retained.length)
  );
  let added = 0;

  for (const point of candidates) {
    if (added >= desired) break;
    if (!insideAllowedRegion(point.x, point.y)) continue;
    if (!positionIsClear(point.x, point.y, retained, 9.4)) continue;
    retained.push(new Electron(point.x, point.y));
    added += 1;
  }

  let attempts = 0;
  while (added < desired && attempts < desired * 120) {
    attempts += 1;
    const x = left + Math.random() * Math.max(1, right - left);
    const y = top + Math.random() * Math.max(1, bottom - top);
    if (!insideAllowedRegion(x, y)) continue;
    if (!positionIsClear(x, y, retained, 9.2)) continue;
    retained.push(new Electron(x, y));
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

function seedConductorPopulation(electrons, ions, targetCount, potentialDifference) {
  const seeded = [...electrons];
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
    Math.max(0, MAX_TOTAL_ELECTRONS - seeded.length)
  );
  let added = 0;

  for (const point of candidates) {
    if (added >= desired) break;
    if (!pointInRoundedRect(point.x, point.y, FILAMENT, 18, WALL_BUFFER)) {
      continue;
    }
    if (!positionIsClear(point.x, point.y, seeded, 9.2)) continue;

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
    added += 1;
  }

  return seeded;
}

function makeInitialElectronPopulation(voltage, ions) {
  const reservoirTarget = voltageToTargetCount(voltage);
  let electrons = rebuildReservoirPopulation([], reservoirTarget, voltage);
  const conductorTarget = conductorTargetCountFromReservoir(reservoirTarget);
  electrons = seedConductorPopulation(
    electrons,
    ions,
    conductorTarget,
    voltage
  );
  return electrons;
}

function maintainReservoirPopulation(electrons, targetCount, potentialDifference) {
  if (electrons.length >= MAX_TOTAL_ELECTRONS) return;

  let currentCount = 0;
  for (const electron of electrons) {
    if (inSourceReservoir(electron, potentialDifference)) currentCount += 1;
  }

  const missing = Math.min(
    targetCount - currentCount,
    MAX_TOTAL_ELECTRONS - electrons.length
  );

  if (missing <= 0) return;

  // After the slider-triggered rebuild, replace electrons that flow out by
  // spawning fresh ones throughout the source reservoir body so the selected
  // density can be maintained even when the outer edge is crowded.
  const toSpawn = Math.min(missing, 30);
  for (let i = 0; i < toSpawn; i += 1) {
    if (!spawnOneElectron(electrons, potentialDifference)) break;
  }
}

function repelElectrons(electrons, dt) {
  const soft2 = REPULSION_SOFTENING * REPULSION_SOFTENING;

  for (let i = 0; i < electrons.length; i += 1) {
    const a = electrons[i];

    for (let j = i + 1; j < electrons.length; j += 1) {
      const b = electrons[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const r2 = dx * dx + dy * dy;

      if (r2 < 0.0001) continue;

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

function scatterFromIons(electron, ions, tempC, current) {
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

    if (normalVelocity >= 0) continue;

    // Count only a genuine incoming impact. Merely remaining slightly overlapped
    // while already moving away from the ion is not a new collision.
    collisions += 1;

    const speed2Before =
      electron.vx * electron.vx + electron.vy * electron.vy;

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

function drawConnectorNeck(ctx, rect, copperSkinned = false) {
  ctx.save();

  // Keep the physical neck itself the same dark conductor. When the copper
  // skin is active, its overlay is drawn later on top of the electrons so the
  // skin can fade smoothly toward the filament.
  ctx.fillStyle = "rgb(78, 86, 94)";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  if (!copperSkinned) {
    ctx.strokeStyle = "rgba(53, 61, 68, 0.96)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(rect.x + 2, rect.y);
    ctx.lineTo(rect.x + rect.width - 2, rect.y);
    ctx.moveTo(rect.x + 2, rect.y + rect.height);
    ctx.lineTo(rect.x + rect.width - 2, rect.y + rect.height);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rect.x + 5, rect.y + 5);
    ctx.lineTo(rect.x + rect.width - 5, rect.y + 5);
    ctx.moveTo(rect.x + 5, rect.y + rect.height - 5);
    ctx.lineTo(rect.x + rect.width - 5, rect.y + rect.height - 5);
    ctx.stroke();
  }

  ctx.restore();
}

function copperTerminalGradient(ctx, chamber) {
  const gradient = ctx.createLinearGradient(
    chamber.x,
    chamber.y,
    chamber.x + chamber.width,
    chamber.y + chamber.height
  );
  gradient.addColorStop(0, "#dfa06a");
  gradient.addColorStop(0.28, "#c77a42");
  gradient.addColorStop(0.62, "#a95d2d");
  gradient.addColorStop(1, "#d58a4e");
  return gradient;
}

function drawCopperNeckFade(ctx) {
  ctx.save();

  // Left terminal: full copper at the terminal mouth, fading smoothly to
  // transparent exactly as it reaches the filament.
  const leftFade = ctx.createLinearGradient(
    SOURCE_NECK.x - 3,
    0,
    SOURCE_NECK.x + SOURCE_NECK.width,
    0
  );
  leftFade.addColorStop(0, "rgba(199, 122, 66, 1)");
  leftFade.addColorStop(0.24, "rgba(199, 122, 66, 0.98)");
  leftFade.addColorStop(0.55, "rgba(184, 101, 51, 0.72)");
  leftFade.addColorStop(0.82, "rgba(169, 93, 45, 0.34)");
  leftFade.addColorStop(1, "rgba(169, 93, 45, 0)");

  ctx.fillStyle = leftFade;
  ctx.fillRect(
    SOURCE_NECK.x - 3,
    SOURCE_NECK.y - 2,
    SOURCE_NECK.width + 3,
    SOURCE_NECK.height + 4
  );

  // Right terminal: mirror the same continuous fade.
  const rightFade = ctx.createLinearGradient(
    SINK_NECK.x,
    0,
    SINK_NECK.x + SINK_NECK.width + 3,
    0
  );
  rightFade.addColorStop(0, "rgba(169, 93, 45, 0)");
  rightFade.addColorStop(0.18, "rgba(169, 93, 45, 0.34)");
  rightFade.addColorStop(0.45, "rgba(184, 101, 51, 0.72)");
  rightFade.addColorStop(0.76, "rgba(199, 122, 66, 0.98)");
  rightFade.addColorStop(1, "rgba(199, 122, 66, 1)");

  ctx.fillStyle = rightFade;
  ctx.fillRect(
    SINK_NECK.x,
    SINK_NECK.y - 2,
    SINK_NECK.width + 3,
    SINK_NECK.height + 4
  );

  // A very soft warm highlight ties the neck skin into the terminal skin
  // without recreating the old dark, hard-edged neck border.
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "#f1c39e";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(SOURCE_NECK.x, SOURCE_NECK.y + 2);
  ctx.lineTo(SOURCE_NECK.x + SOURCE_NECK.width * 0.58, SOURCE_NECK.y + 2);
  ctx.moveTo(SOURCE_NECK.x, SOURCE_NECK.y + SOURCE_NECK.height - 2);
  ctx.lineTo(
    SOURCE_NECK.x + SOURCE_NECK.width * 0.58,
    SOURCE_NECK.y + SOURCE_NECK.height - 2
  );
  ctx.moveTo(SINK_NECK.x + SINK_NECK.width * 0.42, SINK_NECK.y + 2);
  ctx.lineTo(SINK_NECK.x + SINK_NECK.width, SINK_NECK.y + 2);
  ctx.moveTo(
    SINK_NECK.x + SINK_NECK.width * 0.42,
    SINK_NECK.y + SINK_NECK.height - 2
  );
  ctx.lineTo(
    SINK_NECK.x + SINK_NECK.width,
    SINK_NECK.y + SINK_NECK.height - 2
  );
  ctx.stroke();

  ctx.restore();
}

function drawAmmeterBack(ctx) {
  const cx = AMMETER_X;
  const cy = FILAMENT.y + FILAMENT.height / 2;
  const rx = 53;
  const ry = 389; // 25% shorter ammeter loop

  ctx.save();
  ctx.strokeStyle = "rgba(117, 24, 24, 0.88)";
  ctx.lineWidth = 9;
  ctx.beginPath();
  // Left half is drawn before the conductor so it visibly passes
  // behind the filament/wire.
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI / 2, (Math.PI * 3) / 2);
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

    ctx.strokeStyle = lineColor;
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
  current,
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
    ctx.fillText(`${current.toFixed(3)} A`, x + width - 56, topY + height / 2);
    return;
  }

  drawTimeSeriesPanel(ctx, {
    x,
    y: topY,
    width,
    height: HISTORY_PANEL_HEIGHT,
    title: "CURRENT OVER TIME",
    valueText: `${current.toFixed(3)} A`,
    history,
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

function drawAmmeterFront(ctx, current, history, voltageEvents, now, drawHistory = true) {
  const cx = AMMETER_X;
  const cy = FILAMENT.y + FILAMENT.height / 2;
  const rx = 53;
  const ry = 389; // 25% shorter ammeter loop

  ctx.save();
  ctx.strokeStyle = "rgba(255, 65, 65, 0.97)";
  ctx.lineWidth = 9;
  ctx.beginPath();
  // Right half is drawn after the conductor so it sits in front of
  // the filament/wire.
  ctx.ellipse(cx, cy, rx, ry, 0, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();

  if (drawHistory) {
    drawAmmeterHistory(ctx, history, voltageEvents, now, current);
  }
  ctx.restore();
}


function filamentTrendCurrent(voltage) {
  const straightLimit = 5.5;
  const lowVoltageGradient = 0.429;
  const magnitude = Math.abs(voltage);

  if (magnitude <= straightLimit) {
    return voltage * lowVoltageGradient;
  }

  // Match the straight section's gradient at 5.5 V, then reduce the gradient
  // smoothly to model the rising resistance of a heating filament.
  // These values put the guide at 3.9 A at 12 V while preserving a smooth
  // join to the straight section.
  const bendScale = 4.88;
  const extraVoltage = magnitude - straightLimit;
  const currentMagnitude =
    straightLimit * lowVoltageGradient +
    lowVoltageGradient * bendScale * (1 - Math.exp(-extraVoltage / bendScale));
  return Math.sign(voltage) * currentMagnitude;
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

function drawApparatusLabel(ctx, text, component, gap, xOffset = 0) {
  ctx.save();
  ctx.fillStyle = "#26313a";
  ctx.font = `700 ${SIMULATION_LABEL_FONT_SIZE}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    text,
    component.x + component.width / 2 + xOffset,
    component.y - gap
  );
  ctx.restore();
}

function drawSimulationLabel(ctx, text, x, y) {
  ctx.save();
  ctx.fillStyle = "#26313a";
  ctx.font = `700 ${SIMULATION_LABEL_FONT_SIZE}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const lines = Array.isArray(text) ? text : [text];
  const lineHeight = SIMULATION_LABEL_FONT_SIZE + 2;
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(
      lines[index],
      x,
      y - (lines.length - 1 - index) * lineHeight
    );
  }
  ctx.restore();
}

function drawScene(ctx, electrons, ions, tempC, voltage, current, resistance, targetCount, measurementHistory, voltageEvents, ivPoints, now, ivGraphMinimised, currentHistoryMinimised, hideTerminalElectrons, showTrendOverlay) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, "#f7fafc");
  gradient.addColorStop(1, "#e8edf2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const direction = flowDirection(voltage);
  const sourceRect = sourceRectFor(voltage);
  const sinkRect = sinkRectFor(voltage);

  // Scale only the rendered particle apparatus. The simulation itself continues
  // to use the original coordinates, sizes, velocities and collision geometry.
  ctx.save();
  ctx.translate(PARTICLE_VIEW_OFFSET_X, PARTICLE_VIEW_OFFSET_Y);
  ctx.scale(PARTICLE_VIEW_SCALE, PARTICLE_VIEW_SCALE);

  drawApparatusLabel(ctx, "Metal filament", FILAMENT, 14, -30);
  drawSimulationLabel(
    ctx,
    ["Electron flow", "detector"],
    AMMETER_X,
    FILAMENT.y - 40
  );

  drawAmmeterBack(ctx);

  // Draw the two equal chambers according to their current roles. A negative
  // potential difference swaps reservoir and sink positions without moving the
  // central filament.
  for (const chamber of [RESERVOIR, SINK]) {
    const isSource = chamber === sourceRect;
    drawRoundedRect(ctx, chamber.x, chamber.y, chamber.width, chamber.height, 18);
    ctx.fillStyle = hideTerminalElectrons
      ? copperTerminalGradient(ctx, chamber)
      : isSource
        ? "#edf6fb"
        : "#eef3f6";
    ctx.fill();
    ctx.strokeStyle = "#7e919e";
    ctx.lineWidth = 5;
    ctx.stroke();

    drawTerminalPositiveIonLattice(ctx, chamber);

    drawApparatusLabel(
      ctx,
      isSource ? "Negative terminal" : "Positive terminal",
      chamber,
      10
    );
  }

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
  ctx.strokeStyle = "rgba(53, 61, 68, 0.96)";
  ctx.lineWidth = 5;
  ctx.stroke();

  drawConnectorNeck(ctx, SOURCE_NECK, hideTerminalElectrons);
  drawConnectorNeck(ctx, SINK_NECK, hideTerminalElectrons);

  // Heat colour is deliberately visual rather than black-body accurate.
  // Cold ions start neutral grey, then warm progressively through rust/red
  // into orange/amber over an even 20 C -> 2000 C temperature scale.
  const heatLevel = Math.min(1, Math.max(0, (tempC - AMBIENT_TEMP) / (2000 - AMBIENT_TEMP)));
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

  // Compact legend for the ion heat scale.
  const legendW = Math.min(210, FILAMENT.width - 20);
  const legendX = FILAMENT.x + (FILAMENT.width - legendW) / 2;
  const legendY = FILAMENT.y + FILAMENT.height + 54;
  const legendH = 9;
  const heatLegend = ctx.createLinearGradient(legendX, 0, legendX + legendW, 0);
  for (const stop of heatStops) {
    const [r, g, b] = stop.rgb;
    heatLegend.addColorStop(stop.t, `rgb(${r}, ${g}, ${b})`);
  }
  drawRoundedRect(ctx, legendX, legendY, legendW, legendH, 4.5);
  ctx.fillStyle = heatLegend;
  ctx.fill();
  ctx.strokeStyle = "rgba(72, 79, 86, 0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#52606d";
  ctx.font = `${SIMULATION_DETAIL_FONT_SIZE}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("20 °C", legendX, legendY + 23);
  ctx.textAlign = "center";
  ctx.font = `${ION_TEMPERATURE_LABEL_FONT_SIZE}px system-ui, sans-serif`;
  ctx.fillText("Ion temperature", legendX + legendW / 2 - 10, legendY - 16);
  ctx.textAlign = "right";
  ctx.font = `${SIMULATION_DETAIL_FONT_SIZE}px system-ui, sans-serif`;
  ctx.fillText("2000 °C+", legendX + legendW, legendY + 23);

  for (const electron of electrons) {
    const inTerminalBody =
      (pointInRect(electron.x, electron.y, RESERVOIR, 0) ||
        pointInRect(electron.x, electron.y, SINK, 0)) &&
      !inConductor(electron);

    if (hideTerminalElectrons && inTerminalBody) {
      continue;
    }

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

  if (hideTerminalElectrons) {
    drawCopperNeckFade(ctx);
  }

  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(185, 45, 45, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(AMMETER_X, FILAMENT.y + 10);
  ctx.lineTo(AMMETER_X, FILAMENT.y + FILAMENT.height - 10);
  ctx.stroke();
  ctx.restore();

  drawAmmeterFront(
    ctx,
    current,
    measurementHistory,
    voltageEvents,
    now,
    false
  );

  ctx.fillStyle = "#5b6770";
  ctx.textAlign = "center";
  ctx.font = `${SIMULATION_DIRECTION_FONT_SIZE}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(
    direction > 0 ? "electrons leave →" : "← electrons leave",
    sinkRect.x + sinkRect.width / 2,
    sinkRect.y + sinkRect.height - 14
  );

  ctx.restore();

  // Analysis panels occupy the aligned right-hand column.
  drawAmmeterHistory(
    ctx,
    measurementHistory,
    voltageEvents,
    now,
    current,
    historyPanelTop(ivGraphMinimised),
    currentHistoryMinimised
  );
  drawIVGraph(ctx, ivPoints, ivGraphMinimised, showTrendOverlay);
}
export default function App() {
  const canvasRef = useRef(null);
  const electronsRef = useRef([]);
  const ionsRef = useRef(makeIonLattice());
  const voltageRef = useRef(6);
  const temperatureRef = useRef(AMBIENT_TEMP);
  const currentRef = useRef(0);
  const crossingsRef = useRef([]);
  const collisionDiagnosticRef = useRef([]);
  const measurementTimeRef = useRef(0);
  const currentHistoryRef = useRef([]);
  const voltageEventsRef = useRef([]);
  const ivPointsRef = useRef([]);
  const lastHistorySampleRef = useRef(0);
  const pausedRef = useRef(false);

  const [voltage, setVoltage] = useState(6);
  const [paused, setPaused] = useState(false);
  const [showCircuitDiagram, setShowCircuitDiagram] = useState(false);
  const [showDensityExplanation, setShowDensityExplanation] = useState(false);
  const [showIVGraphExplanation, setShowIVGraphExplanation] = useState(false);
  const [hideTerminalElectrons, setHideTerminalElectrons] = useState(false);
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
  const hideTerminalElectronsRef = useRef(false);
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
    if (
      !showCircuitDiagram &&
      !showDensityExplanation &&
      !showIVGraphExplanation
    ) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setShowCircuitDiagram(false);
        setShowDensityExplanation(false);
        setShowIVGraphExplanation(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showCircuitDiagram, showDensityExplanation, showIVGraphExplanation]);

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
    hideTerminalElectronsRef.current = hideTerminalElectrons;
  }, [hideTerminalElectrons]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d");
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
        ionsRef.current
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
      const targetCount = voltageToTargetCount(voltageRef.current);

      if (!pausedRef.current) {
        measurementTimeRef.current += dt * 1000;
        maintainReservoirPopulation(electrons, targetCount, voltageRef.current);
        updateIons(ions, temperatureRef.current, now / 1000);
        repelElectrons(electrons, dt);

        let collisionHeat = 0;
        let frameCollisionCount = 0;
        const conductorElectronCount = electrons.reduce(
          (count, electron) => count + (inConductor(electron) ? 1 : 0),
          0
        );

        for (const electron of electrons) {
          moveElectron(electron, dt, voltageRef.current);
          const collisionResult = scatterFromIons(
            electron,
            ions,
            temperatureRef.current,
            currentRef.current
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

        temperatureRef.current += collisionHeat;

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
      } else {
        updateIons(ions, temperatureRef.current, now / 1000);
      }

      // Use a true 5-second rolling average of signed crossing rate. The
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
      const current =
        (netCrossings / (CURRENT_AVERAGE_WINDOW_MS / 1000)) * CURRENT_SCALE;
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

      if (
        !pausedRef.current &&
        now - lastHistorySampleRef.current >= AMMETER_HISTORY_SAMPLE_MS
      ) {
        lastHistorySampleRef.current = now;
        currentHistoryRef.current.push({ time: now, current, resistance });
      }
      currentHistoryRef.current = currentHistoryRef.current.filter(
        (point) => now - point.time <= AMMETER_HISTORY_MS
      );
      voltageEventsRef.current = voltageEventsRef.current.filter(
        (event) => now - event.time <= AMMETER_HISTORY_MS
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
        voltageRef.current,
        current,
        resistance,
        targetCount,
        currentHistoryRef.current,
        voltageEventsRef.current,
        ivPointsRef.current,
        now,
        ivGraphMinimisedRef.current,
        currentHistoryMinimisedRef.current,
        hideTerminalElectronsRef.current,
        showTrendOverlayRef.current
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
      ionsRef.current
    );
    crossingsRef.current = [];
    collisionDiagnosticRef.current = [];
    measurementTimeRef.current = 0;
    currentHistoryRef.current = [];
    voltageEventsRef.current = [];
    // Preserve captured I-V points when resetting the simulation.
    lastHistorySampleRef.current = 0;
    temperatureRef.current = AMBIENT_TEMP;
    currentRef.current = 0;

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

  const applyVoltage = (requestedVoltage) => {
    const nextVoltage = Math.max(
      -MAX_VOLTAGE,
      Math.min(MAX_VOLTAGE, Math.round(Number(requestedVoltage) * 2) / 2)
    );
    const nextTarget = voltageToTargetCount(nextVoltage);
    const now = performance.now();
    const previousDirection = flowDirection(voltageRef.current);
    const nextDirection = flowDirection(nextVoltage);

    const voltageEvents = voltageEventsRef.current;
    const lastEvent = voltageEvents[voltageEvents.length - 1];
    if (lastEvent && now - lastEvent.time < 450) {
      lastEvent.time = now;
      lastEvent.voltage = nextVoltage;
    } else {
      voltageEvents.push({ time: now, voltage: nextVoltage });
    }

    // When polarity reverses, the old reservoir becomes the sink. Clear both
    // external chambers but preserve every electron already in the conductor,
    // then seed the new reservoir on the opposite side.
    if (previousDirection !== nextDirection) {
      electronsRef.current = electronsRef.current.filter(inConductor);
    }

    voltageRef.current = nextVoltage;
    setVoltage(nextVoltage);
    electronsRef.current = rebuildReservoirPopulation(
      electronsRef.current,
      nextTarget,
      nextVoltage
    );
  };

  const handleVoltageChange = (event) => {
    applyVoltage(event.target.value);
  };

  const stepVoltage = (delta) => {
    applyVoltage(voltageRef.current + delta);
  };

  const captureDataPoint = () => {
    const measurementNow = measurementTimeRef.current;
    crossingsRef.current = crossingsRef.current.filter(
      (crossing) =>
        measurementNow - crossing.time <= CURRENT_AVERAGE_WINDOW_MS
    );
    const netCrossings = crossingsRef.current.reduce(
      (sum, crossing) => sum + crossing.direction,
      0
    );
    const current =
      (netCrossings / (CURRENT_AVERAGE_WINDOW_MS / 1000)) * CURRENT_SCALE;

    ivPointsRef.current.push({
      voltage: voltageRef.current,
      current,
    });
  };

  const clearCapturedData = () => {
    ivPointsRef.current = [];
  };

  const targetCount = voltageToTargetCount(voltage);

  return (
    <div className="fs-page">
      <style>{layoutCss}</style>

      <main className="fs-shell">
        <header className="fs-header">
          <h1>Filament conduction simulation</h1>

          <div className="fs-header-actions">
            <button
              type="button"
              className="fs-circuit-diagram-button"
              onClick={() => setShowDensityExplanation(true)}
            >
              Why electron density?
            </button>

            <button
              type="button"
              className="fs-circuit-diagram-button"
              onClick={() => setShowIVGraphExplanation(true)}
            >
              I-V graph explanation
            </button>

            <button
              type="button"
              className="fs-circuit-diagram-button"
              onClick={() => setShowCircuitDiagram(true)}
            >
              Show circuit diagram
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

                <div className="fs-slider-wrap">
                  <input
                    className="fs-slider"
                    type="range"
                    min={-MAX_VOLTAGE}
                    max={MAX_VOLTAGE}
                    step="0.5"
                    value={voltage}
                    onChange={handleVoltageChange}
                  />
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
              <div className="fs-actions fs-actions-top">
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
              </div>

              <div className="fs-actions fs-actions-bottom">
                <button
                  type="button"
                  className={`fs-terminal-electron-toggle${
                    hideTerminalElectrons ? " is-active" : ""
                  }`}
                  onClick={() =>
                    setHideTerminalElectrons((value) => !value)
                  }
                >
                  {hideTerminalElectrons
                    ? "Show terminal electrons"
                    : "Hide terminal electrons"}
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
                  value={`${readout.current.toFixed(1)} A`}
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

      {showDensityExplanation && (
        <div
          className="fs-circuit-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowDensityExplanation(false);
            }
          }}
        >
          <div
            className="fs-circuit-modal fs-density-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fs-density-modal-title"
          >
            <div className="fs-circuit-modal-header">
              <h2 id="fs-density-modal-title">Why use electron density?</h2>
              <button
                type="button"
                className="fs-circuit-modal-close"
                onClick={() => setShowDensityExplanation(false)}
                aria-label="Close electron density explanation"
                title="Close"
              >
                ×
              </button>
            </div>

            <div className="fs-density-modal-body">
              <p>
                Potential difference is an invisible driving effect, so this
                simulation needs a simple way to make it visible.
              </p>
              <p>
                A higher potential difference is shown using more electrons in
                the source terminal. Fewer electrons represent a smaller
                potential difference. Reversing the potential difference swaps
                which terminal acts as the source.
              </p>
              <p>
                This is a visual model rather than a literal picture of what
                happens inside a real power supply. It is used here to make it
                easier to see how changing potential difference affects the
                movement of electrons and therefore the current.
              </p>
            </div>
          </div>
        </div>
      )}

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

      {showCircuitDiagram && (
        <div
          className="fs-circuit-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowCircuitDiagram(false);
            }
          }}
        >
          <div
            className="fs-circuit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fs-circuit-modal-title"
          >
            <div className="fs-circuit-modal-header">
              <h2 id="fs-circuit-modal-title">Circuit diagram</h2>
              <button
                type="button"
                className="fs-circuit-modal-close"
                onClick={() => setShowCircuitDiagram(false)}
                aria-label="Close circuit diagram"
                title="Close circuit diagram"
              >
                ×
              </button>
            </div>

            <div className="fs-circuit-modal-body">
              <img
                src={circuitDiagram}
                alt="Circuit diagram"
                className="fs-circuit-diagram-image"
              />
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
    left: 3.75%;
    top: 3.1%;
    width: calc(50% - 6px);
    box-sizing: border-box;
    padding: clamp(3px, 0.3vw, 4.5px) clamp(5px, 0.45vw, 7px) clamp(5px, 0.42vw, 6.5px);
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: clamp(6px, 0.65vw, 10px);
    align-items: center;
    border: 1px solid rgba(203, 213, 223, 0.92);
    border-radius: 12px;
    background: rgba(248, 250, 252, 0.94);
    backdrop-filter: blur(3px);
    box-shadow: 0 4px 14px rgba(31, 41, 51, 0.07);
  }

  .fs-stage-controls .fs-voltage-control {
    transform: translateY(3px);
  }

  .fs-stage-controls .fs-voltage-heading {
    width: 240px;
    justify-content: center;
    gap: 7px;
    font-size: clamp(10px, 0.82vw, 13px);
  }

  .fs-stage-controls .fs-voltage-value {
    padding: 0 5px;
    border: 1px solid #9fc5ed;
    border-radius: 5px;
    background: #eaf4ff;
    color: #174f7a;
    font-size: clamp(11px, 0.9vw, 14px);
    font-variant-numeric: tabular-nums;
  }

  .fs-stage-controls .fs-slider-wrap {
    width: 72%;
    min-width: 145px;
    margin-top: 2px;
    padding-bottom: 20px;
  }

  .fs-stage-controls .fs-voltage-stepper {
    grid-template-columns: 25px 180px 25px;
    width: max-content;
    margin-top: 7px;
    gap: 5px;
  }

  .fs-stage-controls .fs-voltage-stepper .fs-slider-wrap {
    width: 180px;
    min-width: 180px;
    max-width: 180px;
  }

  .fs-stage-controls .fs-slider {
    width: 180px;
    min-width: 180px;
    max-width: 180px;
  }

  .fs-stage-controls .fs-voltage-step-button {
    width: 25px;
    height: 25px;
    font-size: 15px;
    transform: translateY(-4px);
  }

  .fs-stage-controls .fs-slider-zero-tick {
    top: 12px;
    height: 4px;
  }

  .fs-stage-controls .fs-slider-zero-label {
    top: 10px;
    font-size: 8px;
  }

  .fs-stage-controls .fs-control-detail {
    margin-top: 0;
    font-size: clamp(7px, 0.62vw, 10px);
  }

  .fs-stage-controls .fs-actions {
    display: grid;
    align-items: center;
    justify-content: stretch;
    gap: 4px;
    min-width: 0;
  }

  .fs-stage-controls .fs-actions-top {
    grid-template-columns: 100px 68px 60px;
    justify-content: end;
  }

  .fs-stage-controls .fs-actions-bottom {
    grid-template-columns: 122px 110px;
    justify-content: end;
  }

  .fs-stage-controls .fs-actions button {
    width: 100%;
    min-height: 28px !important;
    white-space: nowrap;
    padding: 4px 8px !important;
    font-size: clamp(9px, 0.65vw, 10.5px) !important;
    border-radius: 8px !important;
  }

  .fs-stage-controls .fs-control-side {
    display: grid;
    grid-template-rows: auto auto;
    row-gap: 4px;
    align-content: center;
    justify-items: stretch;
    width: 236px;
    min-width: 0;
    justify-self: end;
  }

  .fs-stage-controls .fs-terminal-electron-toggle {
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid #b77a52;
    border-radius: 7px;
    background: #fff8f2;
    color: #704328;
    font-size: clamp(8px, 0.62vw, 10px);
    font-weight: 750;
    line-height: 1.1;
    white-space: nowrap;
    cursor: pointer;
  }

  .fs-stage-controls .fs-terminal-electron-toggle.is-active {
    border-color: #99552f;
    background: #c57943;
    color: #ffffff;
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

    .fs-stage-controls .fs-actions-top {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .fs-stage-controls .fs-actions-bottom {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .fs-stage-controls .fs-control-side {
      justify-items: start;
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

    .fs-stage-controls .fs-actions-top {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .fs-stage-controls .fs-actions-bottom {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;
