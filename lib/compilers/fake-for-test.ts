// Copyright (c) 2017, Compiler Explorer Authors
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

import _ from 'underscore';

import {
    ActiveTool,
    BypassCache,
    ExecutionParams,
    FiledataPair,
} from '../../types/compilation/compilation.interfaces.js';
import type {PreliminaryCompilerInfo} from '../../types/compiler.interfaces.js';
import {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import {SelectedLibraryVersion} from '../../types/libraries/libraries.interfaces.js';
import {BaseCompiler} from '../base-compiler.js';
import {CompilerArguments} from '../compiler-arguments.js';

export class FakeCompiler {
    public possibleArguments: CompilerArguments;
    public lang: any;
    private compiler: any;
    private info: any;

    static get key() {
        return 'fake-for-test';
    }

    constructor(info: Partial<PreliminaryCompilerInfo>) {
        this.compiler = Object.assign(
            {
                id: 'fake-for-test',
                lang: 'fake-lang',
                options: '',
            },
            info,
        );
        this.lang = {id: this.compiler.lang, name: `Language ${this.compiler.lang}`};
        this.info = info;
        this.possibleArguments = new CompilerArguments('fake-for-test');
    }

    initialise(mtime: Date, clientOptions: any, isPrediscovered: boolean): Promise<BaseCompiler | null> {
        throw new Error('Method not implemented.');
    }

    getInfo() {
        return this.compiler;
    }

    getDefaultFilters() {
        return {};
    }

    getDefaultExecOptions() {
        return {};
    }

    getRemote() {
        return null;
    }

    compile(
        source: string,
        options: string[],
        backendOptions: Record<string, any>,
        filters: ParseFiltersAndOutputOptions,
        bypassCache: BypassCache,
        tools: ActiveTool[],
        executeParameters: ExecutionParams,
        libraries: SelectedLibraryVersion[],
        files?: FiledataPair[],
    ) {
        const inputBody = {
            input: {
                source: source,
                options: options,
                backendOptions: backendOptions,
                filters: filters,
                files: files,
                tools: tools,
            },
        };

        return Promise.resolve(_.extend(this.info.fakeResult || {}, inputBody));
    }

    cmake(files: FiledataPair[], options: string[]) {
        return Promise.resolve(
            _.extend(this.info.fakeResult || {}, {
                input: {
                    files: files,
                    options: options,
                },
            }),
        );
    }
}
