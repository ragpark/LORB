/**
 * Where this application lives, for navigations that have to come back to it.
 *
 * An application is served either at the root of its own origin or under a path prefix, depending on
 * the deployment's topology, and it cannot know which from build-time configuration alone. Anything
 * that navigates away and expects to return — signing out, or restarting sign-in after a session
 * expires — has to name the application rather than the origin. `location.origin` is the same string
 * in both topologies and is only correct in one of them: under a prefix it lands on whatever the
 * origin root serves, which is the API's own index rather than the application.
 *
 * The document's own directory is correct in both, and needs no configuration to be right.
 *
 * At an origin root the bare origin is returned rather than the directory, which differ by a
 * trailing slash. An identity provider matches a logout URL by exact string, and deployments that
 * already registered the bare origin must keep working.
 */
export function appBaseUrl(href: string = location.href, origin: string = location.origin): string {
  const directory = new URL(".", href).href;
  return directory === `${origin}/` ? origin : directory;
}
