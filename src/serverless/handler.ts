import { createServerlessFetchHandler } from '../adapters/http/serverlessApp.js';

export const handleServerlessRequest = createServerlessFetchHandler();

export default handleServerlessRequest;
