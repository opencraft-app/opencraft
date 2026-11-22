// Trusted installation fixture: declares one group creation option and records
// the values the native owner resolves for each newly created group.
export const communicationExtension = {
  groupCreateOptions: [{
    id: 'linked-group',
    label: { id: 'fixture.channels.group.linked', defaultMessage: 'Also create a linked group' },
    description: { id: 'fixture.channels.group.linkedHint', defaultMessage: 'Messages stay in sync.' },
    defaultSelected: true,
  }],
  groupCreated(service, db, context, id, input) {
    db.prepare('INSERT INTO fixture_group_options(channel_id, actor_id, options) VALUES(?,?,?)')
      .run(id, context.actorId, JSON.stringify(input.options));
  },
};
