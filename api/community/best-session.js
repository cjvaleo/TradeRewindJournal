// GET /api/community/best-session?community_id=X — session breakdown.
import { communityEndpoint, aggSessions } from '../_lib/community.js';
export default communityEndpoint(aggSessions, 'sessions');
