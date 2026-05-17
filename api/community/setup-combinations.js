// GET /api/community/setup-combinations?community_id=X — top winning combos.
import { communityEndpoint, aggCombos } from '../_lib/community.js';
export default communityEndpoint(aggCombos, 'combos');
