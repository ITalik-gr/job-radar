/**
 * The registration point for adapters, CLAUDE.md section 4. Catalogs bring companies, boards
 * bring companies and the hiring signal, lead sources bring explicit demand with its company.
 * Each adapter is added here only together with a smoke test on a fixture.
 */
import { registerSource } from './registry.js';
import { greenhouse } from './boards/greenhouse.js';
import { lever } from './boards/lever.js';
import { ashby } from './boards/ashby.js';
import { getro } from './boards/getro.js';
import { hnHiring } from './boards/hnhiring.js';
import { douBoard } from './boards/dou.js';
import { djinni } from './boards/djinni.js';
import { dou } from './catalogs/dou.js';
import { awwwards } from './catalogs/awwwards.js';
import { yc } from './catalogs/yc.js';
import { places } from './catalogs/places.js';
import { prozorro } from './leads/prozorro.js';
import { ainFunding, devuaFunding } from './leads/funding.js';

for (const source of [greenhouse, lever, ashby, getro, hnHiring, douBoard, djinni, dou, awwwards, yc, places, prozorro, ainFunding, devuaFunding]) {
  registerSource(source);
}

export { greenhouse, lever, ashby, getro, hnHiring, douBoard, djinni, dou, awwwards, yc, places, prozorro, ainFunding, devuaFunding };
