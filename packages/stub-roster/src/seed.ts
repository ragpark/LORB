// STUB — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-07. Synthetic seed data only.

export interface StubLearner {
  /** Same shape the synthetic IES accepts at POST /dev-login, so pseudonyms line up. */
  learner_id: string;
  /** Synthetic display name. Never leaves the teacher-facing display layer. */
  display_name: string;
}

export interface StubTopic {
  topic: string;
  taught_on: string;
  summary: string;
}

export interface StubClass {
  class_id: string;
  name: string;
  year_group: string;
  subject: string;
  learners: StubLearner[];
  recent_topics: StubTopic[];
}

const learners = (prefix: string, names: string[]): StubLearner[] =>
  names.map((display_name, index) => ({ learner_id: `synthetic-${prefix}-${String(index + 1).padStart(2, "0")}`, display_name }));

export const STUB_CLASSES: StubClass[] = [
  {
    class_id: "9c1f0a5e-7d2b-4f83-9a6c-2b8e5d4a1c30",
    name: "9B Mathematics",
    year_group: "Year 9",
    subject: "Mathematics",
    learners: learners("9b-maths", [
      "Learner Alpha", "Learner Bravo", "Learner Charlie", "Learner Delta",
      "Learner Echo", "Learner Foxtrot", "Learner Golf", "Learner Hotel",
    ]),
    recent_topics: [
      { topic: "Ratio and proportion", taught_on: "2026-08-10", summary: "Simplifying ratios and dividing a quantity in a given ratio." },
      { topic: "Percentage change", taught_on: "2026-08-13", summary: "Increase, decrease, and reverse percentage problems." },
      { topic: "Direct and inverse proportion", taught_on: "2026-08-17", summary: "Recognising proportional relationships from tables and graphs." },
    ],
  },
  {
    class_id: "4d7b62e1-3a90-4c5e-8f21-6ac9b0e7d452",
    name: "10A Combined Science",
    year_group: "Year 10",
    subject: "Science",
    learners: learners("10a-science", [
      "Learner India", "Learner Juliett", "Learner Kilo", "Learner Lima", "Learner Mike",
    ]),
    recent_topics: [
      { topic: "Cell transport", taught_on: "2026-08-11", summary: "Diffusion, osmosis, and active transport compared." },
      { topic: "Energy stores and transfers", taught_on: "2026-08-16", summary: "Identifying stores and drawing transfer diagrams." },
    ],
  },
];

export const stubClassById = new Map(STUB_CLASSES.map((entry) => [entry.class_id, entry]));

export const classSummary = (entry: StubClass) => ({
  class_id: entry.class_id,
  name: entry.name,
  year_group: entry.year_group,
  subject: entry.subject,
  learner_count: entry.learners.length,
});
