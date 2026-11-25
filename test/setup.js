"use strict";
// The tests expect the neutral Leeds demo. A deployment's own DEFAULT_BRAND (the showcase sets it to hvo,
// and Render runs the tests at build time) mustn't change which practice they see, and nor must the brands
// it withdraws (HIDDEN_BRANDS=hvo on the public demo).
delete process.env.DEFAULT_BRAND;
delete process.env.HIDDEN_BRANDS;
// The tests read the database through the developer-only "under the hood" endpoints.
process.env.UNDER_THE_HOOD = "1";
