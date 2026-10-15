/* Branding - one place for the company and owner name shown in the app, the server console and the manual. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PWBrand = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var company = 'Mullaloo Motorsport Engineering Solutions';
  var owner = 'Pietro';
  return { company: company, owner: owner, line: company + ' - ' + owner, product: 'Pit Wall Pro2' };
});
