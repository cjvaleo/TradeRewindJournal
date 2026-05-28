#!/usr/bin/env node
// Local-only test driver for the Session 20j canvas-rendered EOD card.
// NOT shipped as a route (the leading "_" exempts it from Vercel's
// /api file-based routing).
//
// Run: node api/eod/_test-render.mjs
// Writes /tmp/rewind-test-personal.png + /tmp/rewind-test-group.png.

import { writeFileSync } from 'node:fs';
import { drawCard } from './render-card.js';

const samplePersonal = {
  type: 'personal',
  data: {
    etDate: '2026-05-27',
    totalPnl: 1591.80,
    tradeCount: 3,
    winRate: 67,
    avgR: 1.4,
    avgRCount: 3,
    handle: 'cjvaleo',
    initials: 'CJ',
    trades: [
      { id:'t1', sym:'NQ', type:'long',  pnl:  856.50, rr: 2.1, stop: 23000, time: '09:32' },
      { id:'t2', sym:'ES', type:'short', pnl:  420.00, rr: 1.3, stop: 5860,  time: '10:15' },
      { id:'t3', sym:'CL', type:'long',  pnl:  315.30, rr: 1.8, stop: 78.50, time: '11:42' },
    ],
  },
};

const sampleGroup = {
  type: 'group',
  data: {
    etDate: '2026-05-27',
    totalPnl: -213.42,
    tradeCount: 7,
    winRate: 43,
    avgPerTrade: -30.49,
    community: { id:'c1', name:'Trading Ark', memberCount: 128 },
    traders: [
      { user_id:'u1', username:'kingrat',  pnl:  2640.00, isMe: false, avatar_finish:'gold',     initials:'KR' },
      { user_id:'u2', username:'cjvaleo',  pnl:  -420.50, isMe: true,  avatar_finish:'sapphire', initials:'CJ' },
      { user_id:'u3', username:'bigshort', pnl: -2432.92, isMe: false, avatar_finish:'rosegold', initials:'BI' },
    ],
  },
};

function run(label, payload, out) {
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();
  const png = drawCard(payload);
  const t1 = Date.now();
  console.log('rendered in', t1 - t0, 'ms — bytes:', png.length);
  writeFileSync(out, png);
  console.log('wrote', out);
}

run('Personal', samplePersonal, '/tmp/rewind-test-personal.png');
run('Group',    sampleGroup,    '/tmp/rewind-test-group.png');
console.log('\nDone.');
