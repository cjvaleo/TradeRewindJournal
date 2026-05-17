// GET /api/community/avg-contracts?community_id=X — sizing behavior.
import { communityEndpoint, aggContracts } from '../_lib/community.js';
export default communityEndpoint(aggContracts, 'contracts');
