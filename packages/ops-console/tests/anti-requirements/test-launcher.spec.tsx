// @vitest-environment jsdom
//
// Declared rather than inherited: this file renders the component, and the repository-root `vitest
// run` collects it too, where the environment defaults to node. Its sibling suite pins `node` for
// the mirror-image reason — it reads sources off disk instead of rendering them.
/**
 * The test launcher must not offer a pair the Runtime API will refuse.
 *
 * A launch names a repository and an object, and the launch route rejects the request when the
 * object belongs to a different repository — as OBJECT_NOT_FOUND, which reads as "no such object"
 * for one the operator picked out of the list in front of them. The launcher had two defaults that
 * could disagree: the repository fell back to the first listed, the object to the first of any
 * repository, and a chosen object survived a change of repository.
 */
// Imported here rather than relied on from the package's setup file, which the repository-root run
// does not load. Registering twice is harmless; missing matchers fail as "Invalid Chai property".
import '@testing-library/jest-dom/vitest';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {Launcher} from '../../src/App.js';

const FIRST='11111111-1111-4111-8111-111111111111';
const SECOND='22222222-2222-4222-8222-222222222222';

const repositories=[{repository_id:FIRST},{repository_id:SECOND}];
const objects=[
 {object_id:'object-in-second',repository_id:SECOND,title:'Ratios and proportion'},
 {object_id:'another-in-second',repository_id:SECOND,title:'Photosynthesis quiz'},
];

const selects=()=>({
 repository:screen.getByLabelText(/Repository ID/i) as HTMLSelectElement,
 object:screen.getByLabelText(/Object ID/i) as HTMLSelectElement,
});

// The package's setup file registers jest-dom only, so renders would otherwise accumulate.
afterEach(cleanup);

describe('test launcher pairing',()=>{
 // The empty first repository must not borrow the second's content to fill its default.
 //
 // The button state is the assertion that matters, not the select's value. With no options to hold
 // it, the rendered select reads empty while the component still had a foreign object in hand — so
 // the old defect was invisible on screen and showed up only in the submitted pair.
 it('offers no object for a repository that holds none, and refuses to submit',()=>{
  render(<Launcher repositories={repositories} objects={objects}/>);
  const {repository,object}=selects();

  expect(repository.value).toBe(FIRST);
  expect(object.value).toBe('');
  expect(screen.getByText(/This repository holds no learning objects/i)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/Issue launch/i})).toBeDisabled();
 });

 it('lists only the selected repository\'s objects',()=>{
  render(<Launcher repositories={repositories} objects={objects}/>);
  fireEvent.change(selects().repository,{target:{value:SECOND}});

  expect(selects().object.options.length).toBe(2);
  expect(selects().object.value).toBe('object-in-second');
  expect(screen.getByRole('button',{name:/Issue launch/i})).toBeEnabled();
 });

 // The pairing has to survive the operator changing their mind, not only the first render.
 it('drops an object selection that the newly chosen repository does not contain',()=>{
  render(<Launcher repositories={repositories} objects={objects}/>);
  fireEvent.change(selects().repository,{target:{value:SECOND}});
  fireEvent.change(selects().object,{target:{value:'another-in-second'}});
  expect(selects().object.value).toBe('another-in-second');

  fireEvent.change(selects().repository,{target:{value:FIRST}});

  expect(selects().object.value).toBe('');
  expect(screen.getByRole('button',{name:/Issue launch/i})).toBeDisabled();
 });
});
