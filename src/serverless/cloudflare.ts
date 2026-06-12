import { handleServerlessRequest } from './handler.js';

export default {
    async fetch(request: Request): Promise<Response> {
        return handleServerlessRequest(request);
    }
};
