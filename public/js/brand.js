/* Branding - one place for the company and owner name shown in the app, the server console and the manual. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbBrand = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var company = 'Mullaloo Motorsport Engineering';
  var owner = 'Pietro Gambarin';
  var year = '2026';
  return { company: company, owner: owner, year: year, line: company + ' - ' + year + ' ' + owner, product: 'Orb - Pit Wall Strategy Manager', short: 'Orb' };
});
