"use strict";
// The tests expect the neutral Leeds demo. A deployment's own DEFAULT_BRAND (the showcase sets it to hvo,
// and Render runs the tests at build time) mustn't change which practice they see.
delete process.env.DEFAULT_BRAND;
