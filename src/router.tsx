import { createRouter } from "@tanstack/react-router";
import { RouteError, NotFoundState } from "~/components/app/pageStates";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // P3-H: every route without its own errorComponent gets the shared
    // friendly fallback (chunk-failure recovery + retry) instead of a raw
    // error dump; not-found gets a real page with a way home.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundState,
  });
}
