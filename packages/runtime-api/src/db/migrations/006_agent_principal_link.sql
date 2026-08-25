-- NOT PRODUCTION — NEEDS HUMAN LORB-001 RE-REVIEW. This is the first identity link between the
-- agent-facing trust domain and the teacher identity the roster is owned by.
--
-- The problem it solves: the internal roster projection served every active class to any caller
-- holding the connector's service token. That token is one connector-wide credential, so in OIDC
-- mode every authenticated teacher could read every other teacher's class metadata, and pass those
-- UUIDs to the class:// resources and assign_quiz.
--
-- Scoping needs the agent's identity to resolve to a teacher, and it cannot be derived: a teacher
-- signs into the Consumer UI through the synthetic IES and their classes are owned by
-- HMAC(iesIssuer|iesSubject|"admin"), while an agent authenticates through a different provider
-- with a different subject. There is no computable relationship between the two, by design.
--
-- So the link is explicit, recorded, and created by the teacher it grants access to. It is not
-- inferred from a matching email, a shared claim, or anything else that would quietly join the two
-- domains. A principal with no row here sees nothing.
create table agent_principal_link (
  agent_issuer text not null,
  agent_subject text not null,
  -- The admin pseudonym whose classes this agent principal may read. Always the pseudonym of the
  -- teacher who created the link; there is no route that links a principal to somebody else.
  teacher_pseudonym text not null,
  label text not null default '',
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (agent_issuer, agent_subject)
);
create index agent_principal_link_teacher_idx on agent_principal_link(teacher_pseudonym) where revoked_at is null;
