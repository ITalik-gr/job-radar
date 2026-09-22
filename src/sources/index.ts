/**
 * The registration point for adapters. The implementation order is defined in
 * CLAUDE.md, section 4: first ATS boards with clean JSON, then RSS, then catalogs,
 * then boards, then a company's own careers page. Each adapter is added here only
 * together with a smoke test on a fixture.
 */
import { registerSource } from './registry.js';
import { greenhouse } from './boards/greenhouse.js';
import { lever } from './boards/lever.js';
import { ashby } from './boards/ashby.js';
import { remoteok } from './boards/remoteok.js';
import { getro } from './boards/getro.js';
import { hnHiring } from './boards/hnhiring.js';
import { douBoard } from './boards/dou.js';
import { djinni } from './boards/djinni.js';
import { rssSources } from './boards/feeds.js';
import { dou } from './catalogs/dou.js';
import { awwwards } from './catalogs/awwwards.js';
import { yc } from './catalogs/yc.js';

for (const source of [greenhouse, lever, ashby, remoteok, getro, hnHiring, douBoard, djinni, ...rssSources, dou, awwwards, yc]) {
  registerSource(source);
}

export { greenhouse, lever, ashby, remoteok, getro, hnHiring, douBoard, djinni, rssSources, dou, awwwards, yc };
