// /api/rules
//   GET  — list the caller's rules (active + inactive) + the template catalogue
//   POST — create a rule: either a custom rule or one instantiated from a
//          template_key. Pro-gated; Bearer auth.

import { sbService } from '../_lib/supabase.js';
import { requirePro } from '../_lib/auth.js';
import { RULE_TEMPLATES, getTemplate } from '../_lib/rule-templates.js';

const RULE_TYPES = ['data', 'subjective'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed', allowed: ['GET', 'POST'] });
    return;
  }
  const user = await requirePro(req, res);
  if (!user) return;
  const sb = sbService();

  // ── GET — list rules ────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('rules')
      .select('id, name, description, rule_type, condition, is_active, is_template, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[rules:GET] read failed:', error.message);
      res.status(500).json({ error: 'rules read failed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ rules: data || [], templates: RULE_TEMPLATES });
    return;
  }

  // ── POST — create a rule ────────────────────────────────────────
  const body = req.body || {};
  let row;

  if (body.template_key) {
    const tpl = getTemplate(body.template_key);
    if (!tpl) {
      res.status(400).json({ error: 'unknown template_key', value: body.template_key });
      return;
    }
    row = {
      user_id: user.id,
      name: tpl.name,
      description: tpl.description,
      rule_type: tpl.rule_type,
      condition: tpl.condition,
      is_template: true,
      is_active: body.is_active === false ? false : true,
    };
  } else {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const rule_type = body.rule_type;
    const condition = body.condition;
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    if (RULE_TYPES.indexOf(rule_type) < 0) {
      res.status(400).json({ error: 'rule_type must be data | subjective' });
      return;
    }
    if (!condition || typeof condition !== 'object' || !condition.type) {
      res.status(400).json({ error: 'condition object with a type is required' });
      return;
    }
    row = {
      user_id: user.id,
      name,
      description: typeof body.description === 'string' ? body.description : null,
      rule_type,
      condition,
      is_template: false,
      is_active: body.is_active === false ? false : true,
    };
  }

  const { data, error } = await sb.from('rules').insert(row).select().single();
  if (error) {
    console.error('[rules:POST] insert failed:', error.message);
    res.status(500).json({ error: 'rule create failed' });
    return;
  }
  console.log('[rules:POST] created', { user_id: user.id, rule_id: data.id });
  res.status(201).json({ rule: data });
}
