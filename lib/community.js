// Auto-join helper for the Trading Ark community.
//
// Idempotent — calling multiple times for the same user is safe; the second+
// calls return { ok: true, alreadyMember: true } without writing.
//
// Fire points (Phase 3 spec):
//   • /oauth/discord/callback  Branch A (Elite confirmation)
//   • /api/stripe/webhook      checkout.session.completed where plan='premium'
//   • /api/cron/daily-role-check  Cases A, B, C, G (defensive — catches users
//                                  whose initial join failed at OAuth/webhook
//                                  time; relies on idempotency)
//
// Race-condition note (v1 trade-off):
// Read-modify-write is NOT fully atomic for concurrent calls. The PostgREST
// `.not('members', 'cs', '{userId}')` guards against a SECOND call for the
// SAME user racing past our read — that case returns alreadyMember=true
// cleanly. But concurrent calls for DIFFERENT users CAN clobber each other's
// appends (each writes their own snapshot of the array, last writer wins).
// In practice this is vanishingly rare for Premium/Elite OAuth+webhook
// traffic. If stronger guarantees are needed later, replace with a Postgres
// function:
//
//   CREATE OR REPLACE FUNCTION join_trading_ark(p_user_id UUID, p_community_id UUID)
//   RETURNS JSON LANGUAGE plpgsql AS $$
//   DECLARE n INT;
//   BEGIN
//     UPDATE communities
//     SET members = array_append(members, p_user_id)
//     WHERE id = p_community_id
//       AND NOT (p_user_id = ANY(COALESCE(members, ARRAY[]::uuid[])));
//     GET DIAGNOSTICS n = ROW_COUNT;
//     RETURN json_build_object('ok', true, 'already_member', n = 0);
//   END;
//   $$;
//
// Then call as: await sb.rpc('join_trading_ark', { p_user_id: userId,
//                                                   p_community_id: communityId });
//
// Returns:
//   { ok: true, alreadyMember: boolean }                      — success
//   { ok: false, reason: 'no_community_id_configured' }       — env missing
//   { ok: false, reason: 'no_user_id' }                       — bad input
//   { ok: false, reason: 'community_not_found' }              — DB row missing
//   { ok: false, reason: 'read_failed'  | 'update_failed', error: <msg> }
//
// Callers should log non-ok results but NOT fail the parent flow (OAuth
// callback, webhook, cron) — community auto-join is a nice-to-have, not a
// blocker for Pro entitlement.

export async function joinTradingArk(sb, userId) {
  const communityId = process.env.TRADING_ARK_COMMUNITY_ID;
  if (!communityId) {
    return { ok: false, reason: 'no_community_id_configured' };
  }
  if (!userId) {
    return { ok: false, reason: 'no_user_id' };
  }

  // 1. Read current members.
  let row;
  try {
    const { data, error } = await sb
      .from('communities')
      .select('members')
      .eq('id', communityId)
      .maybeSingle();
    if (error) return { ok: false, reason: 'read_failed', error: error.message };
    row = data;
  } catch (e) {
    return { ok: false, reason: 'read_failed', error: e && e.message };
  }

  if (!row) {
    return { ok: false, reason: 'community_not_found' };
  }

  const members = Array.isArray(row.members) ? row.members : [];
  if (members.includes(userId)) {
    return { ok: true, alreadyMember: true };
  }

  // 2. Conditional UPDATE — the `.not('members', 'cs', '{userId}')` adds a
  //    server-side guard so we DON'T write if another caller raced ahead and
  //    added this user between our read and our write. The guard fires by
  //    returning zero rows, which we treat as alreadyMember=true.
  const newMembers = members.concat([userId]);
  try {
    const { data: updated, error } = await sb
      .from('communities')
      .update({ members: newMembers })
      .eq('id', communityId)
      .not('members', 'cs', '{' + userId + '}')
      .select('id');
    if (error) return { ok: false, reason: 'update_failed', error: error.message };
    if (!updated || !updated.length) {
      return { ok: true, alreadyMember: true };
    }
    return { ok: true, alreadyMember: false };
  } catch (e) {
    return { ok: false, reason: 'update_failed', error: e && e.message };
  }
}
