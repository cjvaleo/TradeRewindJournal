// GET /api/community/coach-notes?community_id=X — 3 templated insights.
import { communityEndpoint, aggCoach } from '../_lib/community.js';
export default communityEndpoint(aggCoach);
