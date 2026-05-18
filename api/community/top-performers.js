// GET /api/community/top-performers?community_id=X&range=Y
// Profiles the top 25% of a community's members (by net P&L over the range).
import { communityEndpoint, topPerformers } from '../_lib/community.js';
export default communityEndpoint(topPerformers);
