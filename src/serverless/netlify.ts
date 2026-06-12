import { handleServerlessRequest } from './handler.js';

export default async function netlifyHandler(request: Request): Promise<Response> {
    return handleServerlessRequest(request);
}

export const config = {
    path: '/*'
};
