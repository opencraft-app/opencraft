import { mountFooterCast } from './home-footer-cast';
import { mountTestimonialFriends } from './international-home-testimonial-friends';
import { mountHeroArtwork } from './home-hero-artwork';

/** Share the approved artwork, while each section owns its choreography. */
export function mountHomeScrollCast(root: HTMLElement): () => void {
  const stopParade = mountFooterCast(root);
  const stopFriends = mountTestimonialFriends(root);
  const stopHero = mountHeroArtwork(root);
  return () => { stopHero(); stopFriends(); stopParade(); };
}
