// Trusted deployment-owner example. No first-party implementation is moved here.
export default {
  manifest: {
    manifestVersion: 1, id: 'user.hello', name: 'Hello user plugin', version: '1.0.0',
    apiVersion: 1, trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'],
  },
  activate(api) {
    api.commands.register({ id: 'user.hello.greet', title: 'Hello from a user plugin' }, () => 'Hello');
  },
};
