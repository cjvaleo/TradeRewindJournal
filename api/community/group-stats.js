// GET /api/community/group-stats?community_id=X&range=Y
// Community-wide aggregate for the selected range.
import { communityEndpoint, aggGroupStats } from '../_lib/community.js';
export default communityEndpoint(aggGroupStats);
