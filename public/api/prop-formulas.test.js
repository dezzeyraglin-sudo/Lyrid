import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROP_TYPES,
  SIDES,
  GAME_TYPES,
  calculateEnvironment,
  calculatePropEdge,
  gradeProp,
  prizePicksSideAllowed
} from "./prop-formulas.js";

test("classifies contact scoring game", () => {
  const env = calculateEnvironment({
    teamHRIndex: 90,
    xbhIndex: 95,
    parkHRFactor: 85,
    weatherHRFactor: 90,
    pitcherHRWeakness: 95,
    contactRateIndex: 115,
    obpIndex: 110,
    kSuppressionIndex: 120,
    bullpenXwOBAIndex: 108,
    babipRunProfile: 112
  });
  assert.equal(env.gameType, GAME_TYPES.CONTACT);
});

test("calculates over and under edges correctly", () => {
  assert.equal(calculatePropEdge({ projection: 6, line: 5, side: SIDES.MORE }).edgePercent, 0.2);
  assert.equal(calculatePropEdge({ projection: 4, line: 5, side: SIDES.LESS }).edgePercent, 0.2);
});

test("blocks unders on demon/goblin projections", () => {
  assert.equal(prizePicksSideAllowed({ desiredSide: SIDES.LESS, projectionType: "demon" }), false);
  assert.equal(prizePicksSideAllowed({ desiredSide: SIDES.MORE, projectionType: "demon" }), true);
});

test("grades a strong pitcher K under", () => {
  const result = gradeProp({
    propType: PROP_TYPES.PITCHER_KS,
    side: SIDES.LESS,
    projectionType: "normal",
    projection: 3.8,
    line: 5,
    gameType: GAME_TYPES.CONTACT,
    matchupScore: 85,
    roleStability: 80,
    environmentFitBase: 80
  });
  assert.notEqual(result.decision, "PASS");
});
