// GET /api/community/pulse?community_id=X — community pulse summary.
import { communityEndpoint, aggPulse } from '../_lib/community.js';
export default communityEndpoint(aggPulse);
