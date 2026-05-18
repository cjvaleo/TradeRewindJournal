// The 5 starter rules seeded by POST /api/rules/seed-defaults for a user
// with zero rules. Every rule is a subjective YES/NO self-report; the
// `cadence` field decides whether it's reviewed nightly (intra_day) or on
// Saturday (weekly). All seeded active, is_template:false.

export const DEFAULT_RULES = [
  { name: '1 mini per trade',
    description: 'Trade a single contract on every entry.',
    cadence: 'intra_day', condition: { type: 'subjective_check' } },
  { name: '1 win = done',
    description: 'After your first winning trade, the day is finished.',
    cadence: 'intra_day', condition: { type: 'subjective_check' } },
  { name: 'First trade loss → half size',
    description: 'If your first trade loses, cut size to half for the rest of the day.',
    cadence: 'intra_day', condition: { type: 'subjective_check' } },
  { name: 'Only A+ setups',
    description: "Only take setups you'd grade A+.",
    cadence: 'intra_day', condition: { type: 'subjective_check' } },
  { name: 'No trades on Friday',
    description: 'Sit out Fridays — protect the week.',
    cadence: 'weekly', condition: { type: 'subjective_check' } },
];
