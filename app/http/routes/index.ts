// Public
import * as express from 'express';

// Private

// Internal
import { DomainRoutes } from './domain.api';

export class Routes {

    static register(): express.Router {
        let router = express.Router();

        /**
         * Define the routes
         */
        const domainRoutes = new DomainRoutes();

        /**
         * Register the routes
         */
        router = domainRoutes.register(router);

        return router;
    }

}
