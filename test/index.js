/**
* @fileoverview Tests for p4 object
* @author Greg Cochard <greg.cochard@gmail.com>
* @copyright 2014 Greg Cochard, all rights reserved.
*/

'use strict';
var path = require('path'),
assert = require('assert'),
EventEmitter = require('events').EventEmitter,
util = require('util'),
errnoException = util._errnoException,
maybeClose = function(subprocess){
    subprocess._closesGot++;
    if (subprocess._closesGot === subprocess._closesNeeded) {
        subprocess.emit('close', subprocess.exitCode, subprocess.signalCode);
    }
},
flushStdio = function(subprocess) {
    if (subprocess.stdio == null) {
        return;
    }
    subprocess.stdio.forEach(function(stream) {
        if (!stream || !stream.readable || stream._consuming ||
        stream._readableState.flowing) {
            return;
        }
        stream.resume();
    });
},
ChildProcess = function(){
    EventEmitter.call(this);
    var self = this;
    this._closesNeeded = 1;
    this._closesGot = 0;
    this.connected = false;

    this.signalCode = null;
    this.exitCode = null;
    this.killed = false;
    this.spawnfile = null;

    this._handle = {};
    this._handle.owner = this;

    this._handle.onexit = function(exitCode, signalCode) {
        //
        // follow 0.4.x behaviour:
        //
        // - normally terminated processes don't touch this.signalCode
        // - signaled processes don't touch this.exitCode
        //
        // new in 0.9.x:
        //
        // - spawn failures are reported with exitCode < 0
        //
        var syscall = self.spawnfile ? 'spawn ' + self.spawnfile : 'spawn';
        /*eslint-disable no-shadow */
        var err = exitCode < 0 ? errnoException(exitCode, syscall) : null;
        /*eslint-enable no-shadow */

        if (signalCode) {
            self.signalCode = signalCode;
        } else {
            self.exitCode = exitCode;
        }

        if (self.stdin) {
            self.stdin.destroy();
        }

        self._handle.close();
        self._handle = null;

        if (exitCode < 0) {
            if (self.spawnfile) {
                err.path = self.spawnfile;
            }

            self.emit('error', err);
        } else {
            self.emit('exit', self.exitCode, self.signalCode);
        }

        // if any of the stdio streams have not been touched,
        // then pull all the data through so that it can get the
        // eof and emit a 'close' event.
        // Do it on nextTick so that the user has one last chance
        // to consume the output, if for example they only want to
        // start reading the data once the process exits.
        process.nextTick(function() {
            flushStdio(self);
        });

        maybeClose(self);
    };
},
ChildMock = function(){

}
;
util.inherits(ChildProcess, EventEmitter);
var errs = [], stdouts = [], stderrs = [];
ChildMock.exec = function(cmd,opts,cb){
    var err = null, stdout = '', stderr = '';
    var child = new ChildProcess();
    //console.log(opts);
    if(errs.length && stdouts.length && stderrs.length){
        err = errs.pop();
        stdout = stdouts.pop();
        stderr = stderrs.pop();
    }
    setTimeout(function(){
        cb(err,stdout,stderr);
    },5);
    return child;
};

var P4 = require('../lib/p4.js')(ChildMock.exec,path);


describe('P4', function(){

    it('should not share state between multiple objects',function(done){
        var p4s = [];
        var i;
        var p4;

        for(i=0;i<10;i++){
            p4 = new P4();
            i = 'dir'+i;
            p4.cd('/').cd(i);
            p4s.push(p4);
        }

        p4s.forEach(function(p4,idx){
            idx = '/dir'+idx;
            assert.equal(p4.pwd(),idx);
        });

        done();
    });

    it('should work with or without new',function(){
        /*eslint-disable new-cap */
        var p4 = P4();
        /*eslint-enable new-cap */
        assert(p4 instanceof P4);
        var p4n = new P4();
        assert(p4n instanceof P4);
    });

    it('should exec crap',function(done){
        var p4 = new P4();
        stderrs.push('');
        errs.push(null);
        var stdout = 'yay\n';
        stdouts.push(stdout);
        p4.runShellCommand('echo',['yay'],function(err,out,stderr){
            assert.equal(out,stdout);
            assert.ifError(err);
            assert.equal(stderr,null);
            done();
        });
    });

    it('should handle error when it cannot exec',function(done){
        var p4 = new P4();
        stderrs.push('Could not exec file\n');
        errs.push(new Error('ENOENT'));
        stdouts.push('yay\n');
        p4.runShellCommand('echo','yay',function(err,stdout,stderr){
            assert.ok(err);
            assert.equal(err.message,'ENOENT');
            assert.equal(stdout,null);
            assert.equal(stderr,null);
            done();
        });
    });

    it('should run arbitrary p4 command',function(done){
        var p4 = new P4();
        stderrs.push('');
        errs.push(null);
        var stdout = 'yay\n';
        stdouts.push(stdout);
        p4.runCommand('yay',function(err,out,stderr){
            assert.ifError(err);
            assert.equal(stdout,out);
            assert.equal(stderr,null);
            done();
        });
    });

    it('should handle error when exec command fails',function(done){
        var p4 = new P4();
        var stderr = 'error, happy not found\n';
        stderrs.push(stderr);
        errs.push(null);
        var stdout = 'yay\n';
        stdouts.push(stdout);
        p4.runShellCommand('echo',['yay'],function(err,out,stdErr){
            assert.ok(err);
            assert.equal(err.message,stderr);
            assert.equal(out,stdout);
            assert.equal(stdErr,null);
            done();
        });
    });

    it('should edit files',function(done){
        var p4 = new P4();
        stderrs.push('');
        errs.push(null);
        var stdout = ['//depot/path/to/file/foo.js#123 - opened for edit',
            '... //depot/path/to/file/foo.js - also opened by user@workspace',
        ].join('\n');
        stdouts.push(stdout);
        p4.edit('foo.js',function(err,res){
            assert.ifError(err);
            assert.equal(res,stdout);
            done();
        });
    });

    it('should call cb with error when edit fails',function(done){
        var p4 = new P4();
        var thiserror = 'Perforce password (P4PASSWD) invalid or unset.';
        stderrs.push(thiserror+'\n');
        var thiserr = new Error('Command failed: '+thiserror);
        thiserr.killed = false;
        thiserr.code = 1;
        thiserr.signal = null;
        errs.push(thiserr);
        stdouts.push('');
        p4.edit('foo.js',function(err,res){
            assert.ok(err);
            assert.equal(err.message,'Command failed: Perforce password (P4PASSWD) invalid or unset.');
            assert.equal(res,null);
            done();
        });
    });

    it('should add files',function(done){
        var p4 = new P4();
        stderrs.push('');
        errs.push(null);
        var stdout = '//depot/path/to/file/bar.js#1 - opened for add\n';
        stdouts.push(stdout);
        p4.add('bar.js',function(err,res){
            assert.ifError(err);
            assert.equal(res,stdout);
            done();
        });
    });

    it('should call cb with error when add fails',function(done){
        var p4 = new P4();
        var thiserror = 'Perforce password (P4PASSWD) invalid or unset.';
        stderrs.push(thiserror+'\n');
        var thiserr = new Error('Command failed: '+thiserror);
        thiserr.killed = false;
        thiserr.code = 1;
        thiserr.signal = null;
        errs.push(thiserr);
        stdouts.push('');
        p4.add('bar.js',function(err,res){
            assert.ok(err);
            assert.equal(err.message,'Command failed: Perforce password (P4PASSWD) invalid or unset.');
            assert.equal(res,null);
            done();
        });
    });

    it('should smartEdit files',function(done){
        var p4 = new P4();
        stderrs.push('');
        errs.push(null);
        var stdout = '//depot/path/to/file/bar.js#1 - opened for add\n';
        stdouts.push(stdout);
        p4.smartEdit('bar.js',function(err,res){
            assert.ifError(err);
            assert.equal(res,stdout);
            done();
        });
    });

    it('should add when smartEdit edit fails',function(done){
        var p4 = new P4();
        stderrs.push('','bar.js - file(s) not on client.\n');
        stdouts.push('bar.js#1 - opened for add\n','');
        errs.push(null,null);
        p4.smartEdit('bar.js',function(err,res){
            assert.ifError(err);
            assert.equal(res,'bar.js#1 - opened for add\n');
            done();
        });
    });

    it('should call cb with error when smartEdit fails',function(done){
        var p4 = new P4();
        var stderr = 'Perforce password (P4PASSWD) invalid or unset.';
        stderrs.push(stderr+'\n');
        var err = new Error('Command failed: '+stderr);
        stderr += '\n';
        err.killed = false;
        err.code = 1;
        err.signal = null;
        errs.push(err);
        stdouts.push('');
        p4.add('bar.js',function(err,res){
            assert.ok(err);
            assert.equal(err.message,'Command failed: Perforce password (P4PASSWD) invalid or unset.');
            assert.equal(res,null);
            done();
        });
    });

    it('should parse fstat output', function(done){
        var p4 = new P4();
        // Be explicit about setting err, stdout, and stderr before EVERY test
        errs.push(null);
        stderrs.push('');
        stdouts.push([
            '... depotFile //depot/path/to/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped',
            '... headAction edit',
            '... headType text',
            '... headTime 1230890900',
            '... headRev 2',
            '... headChange 123',
            '... headModTime 1230890900',
            '... haveRev 2',
            '... action edit',
            '... change default',
            '... type text',
            '... actionOwner luser',
        ].join('\n'));
        p4.stat('foo.js',function(err,stats){
            assert.ifError(err);
            var expectedStats = {
                depotFile: '//depot/path/to/foo.js',
                clientFile: '/path/to/workspace/foo.js',
                isMapped: true,
                headAction: 'edit',
                headType: 'text',
                headTime: '1230890900',
                headRev: '2',
                headChange: '123',
                headModTime: '1230890900',
                haveRev: '2',
                action: 'edit',
                change: 'default',
                type: 'text',
                actionOwner: 'luser',
            };
            assert.deepEqual(stats,expectedStats);
            done();
        });
    });

    it('should show have revision', function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        stdouts.push('... haveRev 2\n');
        p4.have('foo.js',function(err,revision){
            assert.ifError(err);
            assert.equal(revision,2);
            done();
        });
    });

    it('should handle error on calling have', function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('foo.js - file(s) not on client.\n');
        stdouts.push('');
        p4.have('foo.js',function(err,revision){
            assert.ok(err);
            assert(!revision);
            done();
        });
    });

    it('should call the cb with error if filepath not passed to stat',function(done){
        var p4 = new P4();
        p4.stat(function(err,out){
            assert.ok(err);
            assert.equal(out,null);
            assert.equal(err.message,'Please pass a file to stat!');
            done();
        });
    });

    it('should call the callback with error on stderror',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('fdsa\n');
        stdouts.push('');
        p4.stat('foo.js',function(err,stats){
            assert.ok(err);
            assert(!stats);
            done();
        });
    });

    it('should call the callback with error on err',function(done){
        var p4 = new P4();
        stderrs.push('');
        stdouts.push('');
        errs.push(new Error('ENOENT'));
        p4.stat('foo.js',function(err,stats){
            assert.ok(err);
            assert(!stats);
            done();
        });
    });

    it('should parse perforce fstat output correctly',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('bar - no such file(s).\n');
        stdouts.push([
            '',
            '',
            '',
            '... depotFile //depot/path/to/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped',
            '... headAction edit',
            '... headType text',
            '... headTime 1230890900',
            '... headRev 2',
            '... headChange 123',
            '... headModTime 1230890900',
            '... haveRev 2',
            '... action edit',
            '... change default',
            '... type text',
            '... actionOwner luser',
            '',
            '... depotFile //depot/path/to/bar.js',
            '... clientFile /path/to/workspace/bar.js',
            '... isMapped',
            '... headAction edit',
            '... headType text',
            '... headTime 1230890900',
            '... headRev 2',
            '... headChange 123',
            '... headModTime 1230890900',
            '... haveRev 2',
            '... action edit',
            '... change default',
            '... type text',
            '... actionOwner luser',
        ].join('\n')+'\n');
        var expectedStats = [{
            depotFile: '//depot/path/to/foo.js',
            clientFile: '/path/to/workspace/foo.js',
            isMapped: true,
            headAction: 'edit',
            headType: 'text',
            headTime: '1230890900',
            headRev: '2',
            headChange: '123',
            headModTime: '1230890900',
            haveRev: '2',
            action: 'edit',
            change: 'default',
            type: 'text',
            actionOwner: 'luser',
        },{
            depotFile: '//depot/path/to/bar.js',
            clientFile: '/path/to/workspace/bar.js',
            isMapped: true,
            headAction: 'edit',
            headType: 'text',
            headTime: '1230890900',
            headRev: '2',
            headChange: '123',
            headModTime: '1230890900',
            haveRev: '2',
            action: 'edit',
            change: 'default',
            type: 'text',
            actionOwner: 'luser',
        }];
        p4.statDir(function(err,stats){
            assert.ifError(err);
            assert.ok(stats);
            assert(stats.length);
            assert.deepEqual(stats,expectedStats);
            done();
        });
    });

    it('should cd to filepath when passed to statDir',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        stdouts.push('');
        p4.statDir('/path/to/dir/',function(err,out){
            assert.ifError(err);
            assert(out instanceof Array, 'output not array!');
            assert.equal(p4.pwd(),'/path/to/dir');
            done();
        });
    });

    it('should call cb with error on statDir error',function(done){
        var p4 = new P4();
        errs.push(new Error('fdsa'));
        stderrs.push('');
        stdouts.push('');
        p4.statDir('/path/to/dir/',function(err,out){
            assert.equal(err.message,'fdsa');
            assert.equal(out,null);
            assert.equal(p4.pwd(),'/path/to/dir');
            done();
        });
    });

    it('should call cb with error on parseStats error in statDir',function(done){
        var p4 = new P4();
        errs.push(null);
        stdouts.push([
            '... depotFile //path/to/file/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped ',
            '... headAction edit',
            '... headType xtext',
            '... headTime 1234567890',
            '... headRev 123',
            '... headChange 12345',
            '... headModTime 1234567890',
            '... haveRev 123',
            '... ... otherOpen0 other@some_other_workspace',
            '... ... otherAction0 edit',
            '... ... otherChange0 12340',
            '... ... otherOpen1 other@another_workspace',
            '... ... otherAction1 edit',
            '... ... otherChange1 default',
            '... ... otherOpen2 other2@yet_another_workspace',
            '... ... otherAction2 edit',
            '... ... otherChange2 default',
            '... ... otherOpen3 other@some_other_workspace',
            '... ... otherAction3 edit',
            '... ... otherChange3 12340',
            '... ... otherOpen4 other@another_workspace',
            '... ... otherAction4 edit',
            '... ... otherChange4 default',
            '... ... otherOpen5 other2@yet_another_workspace',
            '... ... otherAction5 edit',
            '... ... otherChange5 default',
            '... ... otherOpen 3',
            ''
        ].join('\n')+'\n');
        stderrs.push('');
        p4.statDir('/path/to/dir/',function(err,out){
            assert(err instanceof Error);
            assert.equal(out,null);
            done();
        });
    });

    it('should handle no such file errors from perforce',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('bar - no such file(s).\n');
        stdouts.push('');
        var expectedStats = {};
        p4.statDir(function(err,stats){
            assert.ifError(err);
            assert.ok(stats);
            assert.deepEqual(stats,expectedStats);
            done();
        });
    });

    it('should handle multiple stat levels with fstat',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');

        stdouts.push([
            '... depotFile //path/to/file/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped ',
            '... headAction edit',
            '... headType xtext',
            '... headTime 1234567890',
            '... headRev 123',
            '... headChange 12345',
            '... headModTime 1234567890',
            '... haveRev 123',
            '... ... otherOpen0 other@some_other_workspace',
            '... ... otherAction0 edit',
            '... ... otherChange0 12340',
            '... ... otherOpen1 other@another_workspace',
            '... ... otherAction1 edit',
            '... ... otherChange1 default',
            '... ... otherOpen2 other2@yet_another_workspace',
            '... ... otherAction2 edit',
            '... ... otherChange2 default',
            '... ... otherOpen3 other@some_other_workspace',
            '... ... otherAction3 edit',
            '... ... otherChange3 12340',
            '... ... otherOpen4 other@another_workspace',
            '... ... otherAction4 edit',
            '... ... otherChange4 default',
            '... ... otherOpen5 other2@yet_another_workspace',
            '... ... otherAction5 edit',
            '... ... otherChange5 default',
            '... ... otherOpen6 other@some_other_workspace',
            '... ... otherAction6 edit',
            '... ... otherChange6 12340',
            '... ... otherOpen7 other@another_workspace',
            '... ... otherAction7 edit',
            '... ... otherChange7 default',
            '... ... otherOpen8 other2@yet_another_workspace',
            '... ... otherAction8 edit',
            '... ... otherChange8 default',
            '... ... otherOpen9 other@some_other_workspace',
            '... ... otherAction9 edit',
            '... ... otherChange9 12340',
            '... ... otherOpen10 other@another_workspace',
            '... ... otherAction10 edit',
            '... ... otherChange10 default',
            '... ... otherOpen 11',
            ''
        ].join('\n')+'\n');

        var expectedStats = {
            depotFile: '//path/to/file/foo.js',
            clientFile: '/path/to/workspace/foo.js',
            isMapped: true,
            headAction: 'edit',
            headType: 'xtext',
            headTime: 1234567890,
            headRev: 123,
            headChange: 12345,
            headModTime: 1234567890,
            haveRev: 123,
            other: [
                {
                    Open: 'other@some_other_workspace',
                    Action: 'edit',
                    Change: 12340,
                },{
                    Open: 'other@another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other2@yet_another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other@some_other_workspace',
                    Action: 'edit',
                    Change: 12340,
                },{
                    Open: 'other@another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other2@yet_another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other@some_other_workspace',
                    Action: 'edit',
                    Change: 12340,
                },{
                    Open: 'other@another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other2@yet_another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },{
                    Open: 'other@some_other_workspace',
                    Action: 'edit',
                    Change: 12340,
                },{
                    Open: 'other@another_workspace',
                    Action: 'edit',
                    Change: 'default',
                },
            ]
        };

        p4.stat('foo.js',function(err,stats){
            assert.ifError(err);
            assert.ok(stats);
            assert.equal(stats.length,expectedStats.length,require('util').inspect({stats:stats,expectedStats:expectedStats},{depth:4}));
            assert.deepEqual(stats,expectedStats,require('util').inspect({stats:stats,expectedStats:expectedStats},{depth:4}));
            stderrs.push('');
            errs.push(null);
            stdouts.push([
                '... ... ... depotFile //depot/path/to/foo.js',
                '... ... ... clientFile /path/to/workspace/foo.js',
                '... ... ... isMapped',
                '... ... ... headAction edit',
                '... ... ... headType text',
                '... ... ... headTime 1230890900',
                '... ... ... headRev 2',
                '... ... ... headChange 123',
                '... ... ... headModTime 1230890900',
                '... ... ... haveRev 2',
                '... ... ... action edit',
                '... ... ... change default',
                '... ... ... type text',
                '... ... ... actionOwner luser',
            ].join('\n')+'\n');
            p4.stat('foo.js',function(err,stats){
                assert.ok(err);
                assert.equal(stats,null);
                done();
            });
        });
    });

    it('should recursively stat dir',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        stdouts.push([
            '',
            '',
            '',
            '... depotFile //depot/path/to/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped',
            '... headAction edit',
            '... headType text',
            '... headTime 1230890900',
            '... headRev 2',
            '... headChange 123',
            '... headModTime 1230890900',
            '... haveRev 2',
            '... action edit',
            '... change default',
            '... type text',
            '... actionOwner luser',
            '',
            '... depotFile //depot/path/to/bar.js',
            '... clientFile /path/to/workspace/bar.js',
            '... isMapped',
            '... headAction edit',
            '... headType text',
            '... headTime 1230890900',
            '... headRev 2',
            '... headChange 123',
            '... headModTime 1230890900',
            '... haveRev 2',
            '... action edit',
            '... change default',
            '... type text',
            '... actionOwner luser',
        ].join('\n')+'\n');
        var expectedStats = [{
            depotFile: '//depot/path/to/foo.js',
            clientFile: '/path/to/workspace/foo.js',
            isMapped: true,
            headAction: 'edit',
            headType: 'text',
            headTime: '1230890900',
            headRev: '2',
            headChange: '123',
            headModTime: '1230890900',
            haveRev: '2',
            action: 'edit',
            change: 'default',
            type: 'text',
            actionOwner: 'luser',
        },{
            depotFile: '//depot/path/to/bar.js',
            clientFile: '/path/to/workspace/bar.js',
            isMapped: true,
            headAction: 'edit',
            headType: 'text',
            headTime: '1230890900',
            headRev: '2',
            headChange: '123',
            headModTime: '1230890900',
            haveRev: '2',
            action: 'edit',
            change: 'default',
            type: 'text',
            actionOwner: 'luser',
        }];
        p4.recursiveStatDir(function(err,stats){
            assert.ifError(err);
            assert.ok(stats);
            assert(stats.length);
            assert.deepEqual(stats,expectedStats);
            stdouts.push([
                        '... depotFile //depot/path/to/foo.js',
                        '... clientFile /path/to/workspace/foo.js',
                        '... isMapped',
                        '... headAction edit',
                        '... headType text',
                        '... headTime 1230890900',
                        '... headRev 2',
                        '... headChange 123',
                        '... headModTime 1230890900',
                        '... haveRev 2',
                        '... action edit',
                        '... change default',
                        '... type text',
                        '... actionOwner luser',
                        '',
                        '... depotFile //depot/path/to/bar.js',
                        '... clientFile /path/to/workspace/bar.js',
                        '... isMapped',
                        '... headAction edit',
                        '... headType text',
                        '... headTime 1230890900',
                        '... headRev 2',
                        '... headChange 123',
                        '... headModTime 1230890900',
                        '... haveRev 2',
                        '... action edit',
                        '... change default',
                        '... type text',
                        '... actionOwner luser',
                    ].join('\n')+'\n');
            stderrs.push('');
            errs.push(null);
            p4.recursiveStatDir('/foo/bar',function(err,stats){
                assert.ifError(err);
                assert.equal(p4.pwd(),'/foo/bar');
                assert.ok(stats);
                assert(stats.length);
                assert.deepEqual(stats,expectedStats);
                done();
            });
        });
    });

    it('should handle error in recursiveStatDir',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('I can\'t let you do that starfox...');
        stdouts.push('');
        p4.recursiveStatDir(function(err,stats){
            assert.ok(err);
            assert.equal(stats,null);
            done();
        });
    });

    it('should throw an error on bad fstat output',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');

        stdouts.push([
            '... depotFile //path/to/file/foo.js',
            '... clientFile /path/to/workspace/foo.js',
            '... isMapped ',
            '... headAction edit',
            '... headType xtext',
            '... headTime 1234567890',
            '... headRev 123',
            '... headChange 12345',
            '... headModTime 1234567890',
            '... haveRev 123',
            '... ... otherOpen0 other@some_other_workspace',
            '... ... otherAction0 edit',
            '... ... otherChange0 12340',
            '... ... otherOpen1 other@another_workspace',
            '... ... otherAction1 edit',
            '... ... otherChange1 default',
            '... ... otherOpen2 other2@yet_another_workspace',
            '... ... otherAction2 edit',
            '... ... otherChange2 default',
            '... ... otherOpen3 other@some_other_workspace',
            '... ... otherAction3 edit',
            '... ... otherChange3 12340',
            '... ... otherOpen4 other@another_workspace',
            '... ... otherAction4 edit',
            '... ... otherChange4 default',
            '... ... otherOpen5 other2@yet_another_workspace',
            '... ... otherAction5 edit',
            '... ... otherChange5 default',
            '... ... otherOpen 3',
            ''
        ].join('\n')+'\n');

        p4.stat('foo.js',function(err,stats){
            assert.equal(stats,null);
            assert.ok(err);
            errs.push(null,null);
            stderrs.push('','');

            stdouts.push([
                '... depotFile //path/to/file/foo.js',
                '... clientFile /path/to/workspace/foo.js',
                '... isMapped ',
                '... headAction edit',
                '... headType xtext',
                '... headTime 1234567890',
                '... headRev 123',
                '... headChange 12345',
                '... headModTime 1234567890',
                '... haveRev 123',
                '... ... otherOpen0 other@some_other_workspace',
                '... ... otherAction0 edit',
                '... ... otherChange0 12340',
                '... ... otherOpen1 other@another_workspace',
                '... ... otherAction1 edit',
                '... ... otherChange1 default',
                '... ... otherOpen2 other2@yet_another_workspace',
                '... ... otherAction2 edit',
                '... ... otherChange2 default',
                '... ... otherOpen3 other@some_other_workspace',
                '... ... otherAction3 edit',
                '... ... otherChange3 12340',
                '... ... otherOpen4 other@another_workspace',
                '... ... otherAction4 edit',
                '... ... otherChange4 default',
                '... ... otherOpen5 other2@yet_another_workspace',
                '... ... otherAction5 edit',
                '... ... otherChange5 default',
                '... ... otherOpen10 other@another_workspace',
                '... ... otherAction10 edit',
                '... ... otherChange10 default',
                ''
            ].join('\n')+'\n',[
                '... depotFile //path/to/file/foo.js',
                '... clientFile /path/to/workspace/foo.js',
                '... isMapped ',
                '... headAction edit',
                '... headType xtext',
                '... headTime 1234567890',
                '... headRev 123',
                '... headChange 12345',
                '... headModTime 1234567890',
                '... haveRev 123',
                '... ... otherOpen0 other@some_other_workspace',
                '... ... otherAction0 edit',
                '... ... otherChange0 12340',
                '... ... otherOpen1 other@another_workspace',
                '... ... otherAction1 edit',
                '... ... otherChange1 default',
                '... ... otherOpen2 other2@yet_another_workspace',
                '... ... otherAction2 edit',
                '... ... otherChange2 default',
                '... ... otherOpen3 other@some_other_workspace',
                '... ... otherAction3 edit',
                '... ... otherChange3 12340',
                '... ... otherOpen4 other@another_workspace',
                '... ... otherAction4 edit',
                '... ... otherChange4 default',
                '... ... otherOpen5 other2@yet_another_workspace',
                '... ... otherAction5 edit',
                '... ... otherChange5 default',
                '... ... otherOpen10 other@another_workspace',
                '... ... otherAction10 edit',
                '... ... otherChange10 default',
                ''
            ].join('\n')+'\n');

            p4.stat('foo.js',function(err,stats){
                assert.ok(err);
                assert.equal(stats,null);
                p4.recursiveStatDir(function(err,stats){
                    assert.ok(err);
                    assert.equal(stats,null);
                    done();
                });
            });
        });
    });

    it('should refuse to cd when passed in setOpts',function(){
        var p4 = new P4();
        p4.cd('/');
        p4.setOpts({cwd:'/a/b/c/d/e/f/g'});
        assert.equal(p4.pwd(),'/');
    });

    it('should set options',function(){
         var p4 = new P4();
         p4.setOpts({fdsa:'fdsa',asdf:'asdf'});
         assert.deepEqual(p4.options,{fdsa:'fdsa',asdf:'asdf'});
    });

    it('should work with revert',function(done){
        var p4 = new P4();
        stderrs.push('');
        stdouts.push('//depot/path/to/file/foo.js#123 - was edit, reverted\n');
        errs.push(null);
        p4.revert('foo.js',function(err,results){
            assert.ifError(err);
            assert(results);
            done();
        });
    });

    it('should call cb with error if no path is passed to revert',function(done){
        var p4 = new P4();
        // No need to push anything to stdouts, stderrs, errs, because exec is not called here
        p4.revert(function(err,results){
            assert.ok(err);
            assert.equal(results,null);
            done();
        });
    });

    it('should work with revertUnchanged',function(done){
        var p4 = new P4();
        stderrs.push('');
        stdouts.push('//depot/path/to/file/foo.js#123 - was edit, reverted\n');
        errs.push(null);
        p4.revertUnchanged(function(err,results){
            assert.ifError(err);
            assert(results);
            done();
        });
    });

    it('should work when revertUnchaged is passed a path',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        stdouts.push('//depot/path/to/file/foo.js#123 - was edit, reverted\n');
        p4.revertUnchanged('bar.js',function(err,results){
            assert.ifError(err);
            assert(results);
            done();
        });
    });

    it('should call cb with error if no path is passed ot have',function(done){
        var p4 = new P4();
        p4.have(function(err,rev){
            assert.ok(err);
            assert.equal(rev,null);
            done();
        });
    });

    it('should submit files',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        var stdout = [
            'Submitting change 123456.',
            'Locking 1 files ...',
            'edit //depot/path/to/file/foo.js#123',
            'Change 123456 submitted.'
        ].join('\n')+'\n';
        stdouts.push(stdout);
        p4.submit('foo.js','adding mad opts to foo yo!',function(err,res){
            assert.ifError(err);
            assert.equal(stdout,res);
            done();
        });
    });

    it('should call cb with error when submit fails',function(done){
        var p4 = new P4();
        errs.push(new Error('ENOENT'));
        stdouts.push('');
        stderrs.push('yeah...about that');
        p4.submit('foo.js','adding mad opts to foo yo!',function(err,res){
            assert.ok(err);
            assert.equal(res,null);
            done();
        });
    });

    it('should call cb with error when stderr is populated during submit',function(done){
        var p4 = new P4();
        errs.push(null);
        stdouts.push('');
        var stderr = 'Could not submit foo.js, please sync/resolve first\n';
        stderrs.push(stderr);
        p4.submit('foo.js','adding mad opts to foo yo!',function(err,res){
            assert.ok(err);
            assert.equal(res,null);
            assert.equal(err.message,stderr);
            done();
        });
    });

    it('should sync',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        var stdout = 'foo.js - file(s) up-to-date.\n';
        stdouts.push(stdout);
        p4.sync('foo.js',function(err,out){
            assert.ifError(err);
            assert.equal(out,stdout);
            done();
        });
    });

    it('should sync even when not given a path',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        var stdout = 'foo.js - file(s) up-to-date.\n';
        stdouts.push(stdout);
        p4.sync(function(err,out){
            assert.ifError(err);
            assert.equal(out,stdout);
            done();
        });
    });

    it('should sync dir',function(done){
        var p4 = new P4();
        errs.push(null,null);
        stderrs.push('','');
        var stdout = 'foo.js - file(s) up-to-date.\n';
        stdouts.push(stdout,stdout);
        p4.syncDir(function(err,out){
            assert.ifError(err);
            assert.equal(out,stdout);
            p4.syncDir('/path/to/dir/',function(err,out){
                assert.ifError(err);
                assert.equal(p4.pwd(),'/path/to/dir');
                assert.equal(out,stdout);
                done();
            });
        });
    });

    it('should sync dir recursively',function(done){
        var p4 = new P4();
        errs.push(null,null);
        stderrs.push('','');
        var stdout = 'foo.js - file(s) up-to-date.\n';
        stdouts.push(stdout,stdout);
        p4.recursiveSyncDir(function(err,out){
            assert.ifError(err);
            assert.equal(out,stdout);
            p4.recursiveSyncDir('/path/to/dir/',function(err,out){
                assert.ifError(err);
                assert.equal(p4.pwd(),'/path/to/dir');
                assert.equal(out,stdout);
                done();
            });
        });
    });

    it('should login',function(done){
        var p4 = new P4();
        errs.push(null);
        stderrs.push('');
        var stdout = 'User foo logged in.';
        stdouts.push(stdout);
        p4.login('foo','foo',function(err,out){
            assert.ifError(err);
            assert.equal(out,stdout);
            done();
        });
    });

});
