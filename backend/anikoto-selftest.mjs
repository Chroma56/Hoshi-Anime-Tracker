import assert from 'node:assert/strict';
import {titleForSeries, exactTitleMatches, findAnikotoEpisodes, resolvePermittedUnit} from './anikoto-provider.mjs';
assert.equal(titleForSeries('al195539', {al195539:'Test Show'}), 'Test Show');
assert.equal(titleForSeries('al0', {}), null);
assert.equal(exactTitleMatches([{id:'anikoto:yes',title:'Test Show'}, {id:'anikoto:no',title:'Other'}], 'test show').length,1);
const mock = {HttpClient:class {}, AnikotoProvider:class {
  async search() { return [{id:'anikoto:show-1',title:'Test Show'}]; }
  async fetchContentUnits() { return [{id:'anikoto:show-1/1',availableLanguages:['sub','dub']}]; }
}};
const episodes = await findAnikotoEpisodes('al195539', {sdk:mock,titleMap:{al195539:'Test Show'}});
assert.equal(episodes.units.length,1);
assert.equal(await resolvePermittedUnit('anikoto:show-1/1','sub',{sdk:mock}),null);
console.log('HOSHI ANIKOTO SELFTEST: 5 PASSED (no network requests)');
