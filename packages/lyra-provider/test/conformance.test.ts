import { CanonicalFixtureAdapter } from "./fixture-adapter.ts";
import { runProviderConformance } from "./conformance.ts";

runProviderConformance(new CanonicalFixtureAdapter());
