// GET /api/community/most-used-confluence?community_id=X — top 5 confluence/TF combos.
import { communityEndpoint, aggConfluence } from '../_lib/community.js';
export default communityEndpoint(aggConfluence);
