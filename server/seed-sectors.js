"use strict";
// Sample data for the demos of services other than opticians. The demo diary, rounds, waiting list and care-home
// visit are built once (server/db.js, in eye-care terms); this rewrites what a patient record, a referral and an
// ad lead say, so each sector's demo reads like that kind of practice. Every person here is made up.

// What the eye-care sample says about a patient's glasses, and what it becomes in each sector.
const KIT = {
  audiology: [[/lab/, "New aids ready to fit"], [/Varifocals/, "Both ears, behind the ear"], [/Bifocals/, "Right ear only"], [/Single/, "Both ears, in the ear"], [/Reading/, "None yet"], [/Lost/, "Lost on ward"]],
  podiatry: [[/lab/, "New insoles on order"], [/Varifocals/, "Orthotic insoles"], [/Bifocals/, "Diabetic shoes"], [/Single/, "None noted"], [/Reading/, "Slippers only"], [/Lost/, "None noted"]],
  physio: [[/lab/, "Perching stool on order"], [/Varifocals/, "Zimmer frame"], [/Bifocals/, "Wheelchair"], [/Single/, "None"], [/Reading/, "Walking stick"], [/Lost/, "Frame left at hospital"]],
  dental: [[/lab/, "New dentures at the lab"], [/Varifocals/, "Full upper, partial lower"], [/Bifocals/, "Full upper and lower"], [/Single/, "Own teeth"], [/Reading/, "Partial lower"], [/Lost/, "Dentures lost on ward"]],
  ot: [[/lab/, "Stairlift on order"], [/Varifocals/, "Grab rails, raised toilet seat"], [/Bifocals/, "Hoist and profiling bed"], [/Single/, "None"], [/Reading/, "Perching stool"], [/Lost/, "Commode from hospital"]],
  nursing: [[/lab/, "Blood thinners"], [/Varifocals/, "Warfarin"], [/Bifocals/, "Insulin"], [/Single/, "None noted"], [/Reading/, "Allergic to plasters"], [/Lost/, "New medication from hospital"]],
};

// Each sample patient's history, by patient id: [label, note].
const HISTORY = {
  audiology: {
    p1: [["10 Oct 2024", "Hearing assessment. Moderate loss both ears. Behind-the-ear aids fitted."]],
    p2: [["29 Sep 2026", "Hearing assessment. Severe loss right ear. New aids ordered, ready to fit."]],
    p3: [["2 Jul 2026", "Aids reprogrammed. Struggles with the small batteries: the carer helps."], ["8 Oct 2026", "Care home called: left aid whistling."]],
    p4: [["Referral", "GP referral: housebound after a stroke, can't hear the TV."]],
    p5: [["28 Sep 2026", "Hearing assessment. Hearing has dropped. New aids ordered, ready to fit."]],
    p6: [["12 Oct 2026", "Aid follow-up. Settled in well."]],
    p7: [["Referral", "Tube on the right aid has split."]],
    p8: [["14 Aug 2026", "Wax in both ears. Softening drops for 2 weeks, then microsuction."]],
    p9: [["Referral", "Daughter says the aids keep falling out."]],
    p10: [["5 Aug 2026", "Private hearing check. Mild loss, aids not needed yet."]],
    p11: [["Referral", "Discharged from hospital, hearing aids lost on the ward."]],
    p13: [["15 Jul 2026", "Tinnitus, left ear. Review in 3 months."]],
    p15: [["Referral", "Battery door broken on the left aid."]],
    p16: [["Referral", "GP: sudden hearing loss in one ear over a week, can't leave home. Prioritise."]],
    p31: [["Referral", "Aid stopped working. Needs a day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "Recurring wax. Microsuction every 6 months."]],
  },
  podiatry: {
    p1: [["10 Oct 2024", "Assessment. Thickened nails, early bunion on the left. Nail care every 8 weeks."]],
    p2: [["29 Sep 2026", "Diabetic foot check. Reduced feeling in both feet. Moderate risk: check every 6 months."]],
    p3: [["2 Jul 2026", "Nail care. Fragile skin: no sharp debridement."], ["8 Oct 2026", "Care home called: red area on the right heel."]],
    p4: [["Referral", "GP referral: housebound after a stroke, nails overgrown."]],
    p5: [["28 Sep 2026", "Nail care. Corn on the left little toe treated."]],
    p6: [["12 Oct 2026", "Nail care. All well."]],
    p7: [["Referral", "Painful corn under the ball of the foot."]],
    p8: [["14 Aug 2026", "Small ulcer on the right big toe. Dressed. Review every 2 weeks."]],
    p9: [["Referral", "Daughter says her toenails catch on her socks."]],
    p10: [["5 Aug 2026", "Private assessment. Plantar fasciitis. Insoles fitted."]],
    p11: [["Referral", "Discharged from hospital, can't reach her feet to cut her nails."]],
    p13: [["15 Jul 2026", "Ingrown toenail, left. Recheck in 3 months."]],
    p15: [["Referral", "Hard skin on the heels, cracking."]],
    p16: [["Referral", "GP: diabetic, new wound on the foot, can't leave home. Prioritise."]],
    p31: [["Referral", "Painful corn. Needs a day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "Diabetic. Foot check every 6 months."]],
  },
  physio: {
    p1: [["10 Oct 2024", "Assessment after a fall. Weak hips. Balance exercises, 6 sessions."]],
    p2: [["29 Sep 2026", "Parkinson's. Neuro physio fortnightly. Walking more steadily."]],
    p3: [["2 Jul 2026", "Review. Transfers with one carer."], ["8 Oct 2026", "Care home called: had a fall, no injury."]],
    p4: [["Referral", "GP referral: stroke 6 weeks ago, weak left side."]],
    p5: [["28 Sep 2026", "Knee replacement 4 weeks ago. Bending to 85°. Exercises progressed."]],
    p6: [["12 Oct 2026", "Exercise session. Stairs practised, managing well."]],
    p7: [["Referral", "Back pain after lifting, can't get in the car."]],
    p8: [["14 Aug 2026", "COPD. Breathing exercises and a walking plan."]],
    p9: [["Referral", "Daughter worried she's unsteady on her feet."]],
    p10: [["5 Aug 2026", "Private assessment. Stiff shoulder. Home exercise plan."]],
    p11: [["Referral", "Discharged from hospital after a hip fracture."]],
    p13: [["15 Jul 2026", "MS. Neuro physio. Review in 3 months."]],
    p15: [["Referral", "Walking frame wobbly, needs checking."]],
    p16: [["Referral", "GP: new weakness in both legs, can't leave home. Prioritise."]],
    p31: [["Referral", "Sciatica. Needs a day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "At risk of falls. Review every 3 months."]],
  },
  dental: {
    p1: [["10 Oct 2024", "Check-up. Gums healthy, two small fillings. Recall in 6 months."]],
    p2: [["29 Sep 2026", "Check-up. Upper denture loose. New denture impressions taken."]],
    p3: [["2 Jul 2026", "Mouth care review. Carers shown how to clean her dentures."], ["8 Oct 2026", "Care home called: denture broken."]],
    p4: [["Referral", "GP referral: housebound after a stroke, no dental check for 3 years."]],
    p5: [["28 Sep 2026", "Check-up. New partial denture made, ready to fit."]],
    p6: [["12 Oct 2026", "Scale and polish. Gums much better."]],
    p7: [["Referral", "Denture rubbing, sore gum."]],
    p8: [["14 Aug 2026", "Decay on two lower teeth. Fillings booked."]],
    p9: [["Referral", "Daughter says her dentures keep falling out."]],
    p10: [["5 Aug 2026", "Private check-up. All clear."]],
    p11: [["Referral", "Discharged from hospital, dentures lost on the ward."]],
    p13: [["15 Jul 2026", "Gum disease. Hygienist every 3 months."]],
    p15: [["Referral", "Broken front tooth, no pain."]],
    p16: [["Referral", "GP: facial swelling and toothache, can't leave home. Prioritise."]],
    p31: [["Referral", "Check-up overdue. Needs a day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "Dry mouth from medication. Fluoride varnish every 6 months."]],
  },
  ot: {
    p1: [["10 Oct 2024", "OT assessment after a fall. Grab rails and a raised toilet seat fitted."]],
    p2: [["29 Sep 2026", "Parkinson's. Struggling with the stairs. Stairlift assessment done."]],
    p3: [["2 Jul 2026", "Hoist transfers with two carers. Sling size checked."], ["8 Oct 2026", "Care home called: hoist sling worn."]],
    p4: [["Referral", "GP referral: home after a stroke, can't get in the bath."]],
    p5: [["28 Sep 2026", "Hip replacement. Equipment for home ordered, ready to fit."]],
    p6: [["12 Oct 2026", "Equipment review. Using the perching stool every day."]],
    p7: [["Referral", "Can't get up from her armchair."]],
    p8: [["14 Aug 2026", "COPD. Energy-saving plan for washing and dressing."]],
    p9: [["Referral", "Daughter worried about her on the stairs at night."]],
    p10: [["5 Aug 2026", "Private assessment for home adaptations. Report sent to the family."]],
    p11: [["Referral", "Discharged from hospital, needs equipment before the weekend."]],
    p13: [["15 Jul 2026", "MS. Wheelchair seating review in 3 months."]],
    p15: [["Referral", "Bath board has cracked."]],
    p16: [["Referral", "GP: two falls this week, lives alone. Prioritise."]],
    p31: [["Referral", "Needs a rail by the back door. A day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "At risk of falls. Equipment review every 6 months."]],
  },
  nursing: {
    p1: [["10 Oct 2024", "On warfarin. INR blood test every 4 weeks."]],
    p2: [["29 Sep 2026", "Leg ulcer, right. Dressing changed, healing."]],
    p3: [["2 Jul 2026", "B12 injection every 12 weeks."], ["8 Oct 2026", "Care home called: skin tear on the left arm."]],
    p4: [["Referral", "GP referral: housebound after a stroke, needs bloods every 3 months."]],
    p5: [["28 Sep 2026", "Blood test for kidney function. Results to the GP."]],
    p6: [["12 Oct 2026", "Blood pressure check: 142/86. GP told."]],
    p7: [["Referral", "Needs a blood test before her hospital appointment."]],
    p8: [["14 Aug 2026", "Diabetic. Bloods every 3 months."]],
    p9: [["Referral", "Daughter asks for her B12 injection at home."]],
    p10: [["5 Aug 2026", "Private health check. All bloods normal."]],
    p11: [["Referral", "Discharged from hospital with a wound to dress."]],
    p13: [["15 Jul 2026", "Pressure sore, grade 2. Dressing twice a week."]],
    p15: [["Referral", "Blood pressure check and observations."]],
    p16: [["Referral", "GP: wound getting worse, can't leave home. Prioritise."]],
    p31: [["Referral", "Yearly bloods. Needs a day's notice: works mornings at the church."]],
    p41: [["14 Apr 2026", "On warfarin. INR every 4 weeks."]],
  },
};

// Recalls due soon, by recall id: [visit type, why].
const RECALLS = {
  audiology: { r1: ["sight", "Yearly hearing check"], r2: ["follow", "Wax removal every 6 months"], r3: ["sight", "Yearly hearing check"], r4: ["sight", "Yearly hearing check"] },
  podiatry: { r1: ["dispense", "Nail care (every 8 weeks)"], r2: ["exam", "Diabetic foot check (every 6 months)"], r3: ["dispense", "Nail care (every 8 weeks)"], r4: ["dispense", "Nail care (every 8 weeks)"] },
  physio: { r1: ["follow", "3-month progress review"], r2: ["follow", "Falls review (every 3 months)"], r3: ["follow", "3-month progress review"], r4: ["follow", "3-month progress review"] },
  dental: { r1: ["sight", "6-month dental check-up"], r2: ["dispense", "Hygienist every 3 months"], r3: ["sight", "6-month dental check-up"], r4: ["sight", "6-month dental check-up"] },
  ot: { r1: ["repair", "6-month equipment review"], r2: ["follow", "Falls review (every 6 months)"], r3: ["repair", "6-month equipment review"], r4: ["repair", "6-month equipment review"] },
  nursing: { r1: ["dispense", "Bloods (every 3 months)"], r2: ["dispense", "INR blood test (every 4 weeks)"], r3: ["dispense", "Bloods (every 3 months)"], r4: ["dispense", "Bloods (every 3 months)"] },
};

// The three website referrals, by id: [what's needed, the referrer's note].
const REFERRALS = {
  audiology: { rf1: ["sight", "Mum keeps turning the TV right up and misses the phone. Mornings are best."], rf2: ["repair", "New resident, room 4. His hearing aids came with him but don't seem to work."], rf3: ["follow", "Ears blocked for two weeks, the drops haven't helped."] },
  podiatry: { rf1: ["dispense", "Mum can't reach her feet any more. Mornings are best."], rf2: ["exam", "New resident, room 4. Diabetic, hasn't had a foot check this year."], rf3: ["follow", "A sore on my heel that won't heal."] },
  physio: { rf1: ["sight", "Mum's had two falls this month. Mornings are best."], rf2: ["exam", "Stroke last month, weak right side. Room 4."], rf3: ["dispense", "Hip replacement in September, I need help getting stronger."] },
  dental: { rf1: ["sight", "Mum hasn't seen a dentist in years and won't eat on one side. Mornings are best."], rf2: ["follow", "New resident, room 4. His dentures don't fit any more."], rf3: ["exam", "Broken tooth, it catches my tongue."] },
  ot: { rf1: ["sight", "Mum can't manage the stairs or the bath any more. Mornings are best."], rf2: ["exam", "New resident, room 4. Needs his room checked before he moves in."], rf3: ["dispense", "I need a rail fitting by my front step."] },
  nursing: { rf1: ["dispense", "Mum needs her bloods taken and can't get to the surgery. Mornings are best."], rf2: ["exam", "New resident, room 4. Leg wound needs dressing."], rf3: ["follow", "My B12 injection is due."] },
};

// The Facebook ad and its two questions, then each lead's two answers.
const LEADS = {
  audiology: { ad: "Free hearing check at home", q: ["Who is the hearing check for?", "Do they wear hearing aids?"], a: { ld1: ["My mum", "No"], ld2: ["Me", "Yes, but they don't work well"], ld3: ["My dad", "No"] } },
  podiatry: { ad: "Podiatry at home, no travelling", q: ["Who is the visit for?", "What do they need help with?"], a: { ld1: ["My mum", "Cutting her toenails"], ld2: ["Me", "A painful corn"], ld3: ["My dad", "He's diabetic, needs a foot check"] } },
  physio: { ad: "Physio at home, no waiting list", q: ["Who is the physio for?", "What's the main problem?"], a: { ld1: ["My mum", "She's had a fall"], ld2: ["Me", "Knee replacement"], ld3: ["My dad", "Weak after a stroke"] } },
  dental: { ad: "A dentist who comes to you", q: ["Who is the visit for?", "What do they need?"], a: { ld1: ["My mum", "A check-up"], ld2: ["Me", "Dentures adjusted"], ld3: ["My dad", "Toothache"] } },
  ot: { ad: "An occupational therapist who comes to you", q: ["Who is the visit for?", "What's getting harder at home?"], a: { ld1: ["My mum", "The stairs"], ld2: ["Me", "Getting in and out of the bath"], ld3: ["My dad", "He's had a fall"] } },
  nursing: { ad: "Blood tests and nursing care at home", q: ["Who is the visit for?", "What's needed?"], a: { ld1: ["My mum", "A blood test"], ld2: ["Me", "A wound dressing"], ld3: ["My dad", "His B12 injection"] } },
};

// Each demo has its own patients: names drawn from these lists, a different selection for each sector, keeping
// each sample patient's sex so their notes still read right. Every name is made up.
const FEMALE = ["Ada", "Agnes", "Alice", "Annie", "Audrey", "Barbara", "Beryl", "Betty", "Brenda", "Carol", "Dorothy", "Doris", "Edna", "Eileen", "Elsie", "Enid", "Evelyn", "Freda", "Gladys", "Gwen", "Hazel", "Hilda", "Ivy", "Jean", "Joyce", "Kathleen", "Lilian", "Marjorie", "Maureen", "Mavis", "Nellie", "Olive", "Pamela", "Rita", "Sheila", "Winifred"];
const MALE = ["Albert", "Alan", "Arthur", "Bernard", "Bill", "Clifford", "Colin", "Cyril", "Dennis", "Derek", "Donald", "Eric", "Ernest", "Fred", "George", "Gordon", "Harold", "Harry", "Herbert", "Jack", "Jim", "Keith", "Kenneth", "Leonard", "Malcolm", "Maurice", "Norman", "Percy", "Ralph", "Raymond", "Roy", "Sidney", "Stanley", "Terence", "Trevor", "Wilfred"];
const SURNAMES = ["Ackroyd", "Armitage", "Barraclough", "Beaumont", "Bentley", "Binns", "Booth", "Bottomley", "Brook", "Butterworth", "Clegg", "Crowther", "Dewhirst", "Dobson", "Ellis", "Fawcett", "Firth", "Garside", "Gledhill", "Greenwood", "Haigh", "Hallas", "Hargreaves", "Hebden", "Hepworth", "Holroyd", "Illingworth", "Jagger", "Kaye", "Kilburn", "Lister", "Lockwood", "Marsden", "Midgley", "Moorhouse", "Mortimer", "Netherwood", "Oldroyd", "Pickles", "Priestley", "Ramsden", "Redfearn", "Riley", "Robinson", "Schofield", "Senior", "Shackleton", "Sowden", "Stansfield", "Sugden", "Sunderland", "Sykes", "Tattersall", "Thackray", "Townend", "Turton", "Utley", "Varley", "Wadsworth", "Walsh", "Whiteley", "Wilkinson", "Womersley", "Wood", "Wormald", "Wrigley", "Yates", "Ashworth", "Brearley", "Calvert", "Dransfield", "Exley"];
const FEMALE_IDS = new Set(["p1", "p3", "p5", "p7", "p9", "p11", "p13", "p15", "p20", "p22", "p24", "p26", "p28", "p30", "p40", "p42", "p-mc1", "p-mc3"]);
const ORDER = ["audiology", "podiatry", "physio", "nursing", "dental", "ot"];

/** Rewrite the eye-care sample (inside the seed's transaction) for a practice in another sector. */
function flavour(db, sector) {
  const id = sector.id;
  if (!KIT[id]) return; // opticians: the sample is already theirs
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  // The team: the optometrists become the sector's lead role, the dispensing optician its support role.
  run("UPDATE clinicians SET role = ? WHERE role = 'Optometrist'", sector.roles.lead);
  run("UPDATE clinicians SET role = ? WHERE role = 'Dispensing optician'", sector.roles.support);
  run("UPDATE users SET title = (SELECT role FROM clinicians WHERE clinicians.id = users.clinician_id) WHERE clinician_id IS NOT NULL");
  // Patient records: no eye prescription, the sector's kit instead of glasses, and the sector's history.
  for (const p of db.prepare("SELECT id, specs FROM patients").all()) {
    const hit = KIT[id].find(([re]) => re.test(p.specs || ""));
    run("UPDATE patients SET specs = ?, rx = NULL WHERE id = ?", hit ? hit[1] : sector.fields.kitNone, p.id);
  }
  run("DELETE FROM notes WHERE author IS NULL");
  for (const [pid, notes] of Object.entries(HISTORY[id])) {
    if (!db.prepare("SELECT 1 FROM patients WHERE id = ?").get(pid)) continue;
    for (const [label, body] of notes) run("INSERT INTO notes (patient_id, label, body, author, created_at) VALUES (?, ?, ?, NULL, '')", pid, label, body);
  }
  for (const [rid, [type, reason]] of Object.entries(RECALLS[id])) {
    const r = db.prepare("SELECT waitlist_id FROM recalls WHERE id = ?").get(rid);
    if (!r) continue;
    run("UPDATE recalls SET type = ?, reason = ? WHERE id = ?", type, reason, rid);
    run("UPDATE waitlist SET type = ?, note = ? WHERE id = ?", type, reason, r.waitlist_id);
  }
  for (const [rf, [need, notes]] of Object.entries(REFERRALS[id])) run("UPDATE referrals SET need = ?, notes = ?, entitlement = '[]', urgent = 0 WHERE id = ?", need, notes, rf);
  const L = LEADS[id];
  for (const [ld, ans] of Object.entries(L.a)) run("UPDATE leads SET campaign = ?, answers = ? WHERE id = ?", L.ad, JSON.stringify(L.q.map((q, i) => [q, ans[i]])), ld);
  // Its own patients, referrers and ad leads: new names throughout, a different set in each sector's demo.
  const k = ORDER.indexOf(id) + 1;
  let f = 0, m = 0, n = 0;
  const nameOf = (female) => `${female ? FEMALE[(f++ + k * 5) % FEMALE.length] : MALE[(m++ + k * 5) % MALE.length]} ${SURNAMES[(n++ + k * 11) % SURNAMES.length]}`;
  for (const p of db.prepare("SELECT id FROM patients ORDER BY rowid").all()) run("UPDATE patients SET name = ? WHERE id = ?", nameOf(FEMALE_IDS.has(p.id)), p.id);
  for (const r of db.prepare("SELECT id, from_kind, from_name FROM referrals ORDER BY id").all()) {
    run("UPDATE referrals SET name = ? WHERE id = ?", nameOf(r.id !== "rf2"), r.id);
    if (r.from_kind === "family") run("UPDATE referrals SET from_name = ? WHERE id = ?", nameOf(true), r.id);
  }
  for (const l of db.prepare("SELECT id FROM leads ORDER BY id").all()) {
    const name = nameOf(l.id !== "ld2"), email = name.toLowerCase().replace(" ", ".") + "@example.com";
    run("UPDATE leads SET name = ?, email = ? WHERE id = ?", name, email, l.id);
    for (const e of db.prepare("SELECT id, to_name, body FROM emails WHERE lead_id = ?").all(l.id))
      run("UPDATE emails SET to_name = ?, to_addr = ?, body = ? WHERE id = ?", name, email, e.body.split(e.to_name.split(" ")[0]).join(name.split(" ")[0]), e.id);
  }
  // No PCSE notifications or glasses sales outside eye care.
  run("DELETE FROM pcse");
  run("DELETE FROM sales");
}

module.exports = { flavour };
