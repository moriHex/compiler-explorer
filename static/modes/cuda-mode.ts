// Copyright (c) 2018, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import $ from 'jquery';

import * as monaco from 'monaco-editor';

// @ts-ignore  "Could not find a declaration file"
import * as cpp from 'monaco-editor/esm/vs/basic-languages/cpp/cpp';
import cppp from './cppp-mode.js';

// We need to create a new definition for cpp so we can remove invalid keywords

function definition(): monaco.languages.IMonarchLanguage {
    const cuda = $.extend(true, {}, cppp); // deep copy

    function addKeywords(keywords: string[]) {
        // (Ruben) Done one by one as if you just push them all, Monaco complains that they're not strings, but as
        // far as I can tell, they indeed are all strings. This somehow fixes it. If you know how to fix it, plz go
        for (let i = 0; i < keywords.length; ++i) {
            cuda.keywords.push(keywords[i]);
        }
    }

    cuda.tokenPostfix = '.cu';

    // Keywords for CUDA
    addKeywords([
        '__host__',
        '__global__',
        '__device__',
        '__shared__',
        '__noinline__',
        '__forceinline__',
        '__restrict__',
    ]);

    return cuda;
}

monaco.languages.register({id: 'cuda'});
monaco.languages.setLanguageConfiguration('cuda', cpp.conf);
monaco.languages.setMonarchTokensProvider('cuda', definition());
