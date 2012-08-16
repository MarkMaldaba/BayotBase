/**
 * The contents of this file are subject to the Mozilla Public
 * License Version 1.1 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of
 * the License at http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS
 * IS" basis, WITHOUT WARRANTY OF ANY KIND, either express or
 * implied. See the License for the specific language governing
 * rights and limitations under the License.
 *
 * The Original Code is BAYOT.
 *
 * The Initial Developer of the Original Code is "Nokia Corporation"
 * Portions created by the Initial Developer are Copyright (C) 2011 the
 * Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   David Wilson <ext-david.3.wilson@nokia.com>
 *   Pami Ketolainen <pami.ketolainen@gmail.com>
 */


/**
 * Run a function, logging any exception thrown to the console. Used for
 * debugging XMLHTTPRequest event handlers, whose exceptions are silently
 * discarded.
 */
function absorb(fn)
{
    try {
        return fn();
    } catch(e) {
        console.error('absorb(): %o', e);
        throw e;
    }
}


/**
 * RPC object. Wraps the parameters of a Bugzilla RPC up along with callbacks
 * indicating completion state.
 */
var Rpc = Base.extend({
    /**
     * Create an instance.
     *
     * @param method
     *      Method name.
     * @param params
     *      Object containing method parameters.
     * @param immediate
     *      Optional; if false, don't immediately start the RPC (e.g. if it is
     *      going to be added to a queue). Defaults to true.
     */
    constructor: function(namespace, method, params, immediate)
    {
        this.namespace = namespace
        this.method = method;
        this.params = params;
        this.response = null;
        this.error = null;

        this.startedCb = jQuery.Callbacks();
        this.doneCb = jQuery.Callbacks();
        this.failCb = jQuery.Callbacks();
        this.completeCb = jQuery.Callbacks()

        // Fires on start; first argument is the RPC object.
        this.started = $.proxy(this.startedCb, "add");
        // Fires on success; first argument is the RPC result.
        this.done = $.proxy(this.doneCb, "add");
        // Fires on failure; first argument is the RPC failure object.
        this.fail = $.proxy(this.failCb, "add");
        // Always fires; first argument is this RPC object.
        this.complete = $.proxy(this.completeCb, "add");

        if(immediate !== false) {
            this.start();
        }
    },

    /**
     * Start the RPC.
     */
    start: function()
    {
        $.jsonRPC.setup({
            endPoint: 'jsonrpc.cgi',
            namespace: this.namespace
        })

        $.jsonRPC.request(this.method, {
            params: [this.params || {}],
            success: $.proxy(this, "_onSuccess"),
            error: $.proxy(this, "_onError"),
        });

        this.startedCb.fire(this);
    },

    /**
     * Fired on success; records the RPC result and fires any callbacks.
     */
    _onSuccess: function(response)
    {
        this.response = response.result;
        var that = this;
        absorb(function()
        {
            that.doneCb.fire(response.result);
            that.completeCb.fire(that);
        });
    },

    /**
     * Fired on failure; records the error and fires any callbacks.
     */
    _onError: function(response)
    {
        this.error = response.error;
        if(typeof console !== 'undefined') {
            console.log('jsonRPC error: %o', this.error);
        }
        var that = this;
        absorb(function()
        {
            that.failCb.fire(response.error);
            that.completeCb.fire(that);
        });
    }
});


/**
 * Display a small progress indicator at the top of the document while any
 * jQuery XMLHttpRequest is in progress.
 */
var RpcProgressView = {
    _CSS_PROPS: {
        background: '#7f0000',
        color: 'white',
        padding: '0.5ex',
        position: 'fixed',
        top: 0,
        right: 0,
        'z-index': 9999999,
        'text-decoration': 'blink'
    },

    init: function()
    {
        if(this._progress) {
            return;
        }

        this._active = 0;
        this._progress = $('<div>Working..</div>');
        this._progress.css(this._CSS_PROPS);
        this._progress.hide();
        this._progress.appendTo('body');
        $(document).ajaxSend($.proxy(this, "_onAjaxSend"));
        $(document).ajaxComplete($.proxy(this, "_onAjaxComplete"));
    },

    /**
     * Handle request start by incrementing the active count.
     */
    _onAjaxSend: function()
    {
        this._active++;
        this._progress.show();
    },

    /**
     * Handle request completion by decrementing the active count, and hiding
     * the progress indicator if there are no more active requests.
     */
    _onAjaxComplete: function()
    {
        this._active--;
        if(! this._active) {
            this._progress.hide();
        }
    }
};

// TODO: this should be moved to somewhere sensible.
$(document).ready($.proxy(RpcProgressView, "init"));

/**
 * Bug class.
 * Stores single bug and handles calling create and update RPC methods.
 */
var Bug = Base.extend({

    constructor: function(bug)
    {
        this.update = Bug.initOnCall(this.update, this);
        this.set = Bug.initOnCall(this.set, this);
        this.add = Bug.initOnCall(this.add, this);
        this.remove = Bug.initOnCall(this.remove, this);

        if (bug.id) {
            // TODO: Might need a better check of bug data completeness
            this._data = bug;
            this._modified = {};
        } else {
            this._modified = bug;
            this._data = {};
        }

        // Fires when bug has been saved successfully or updated from DB
        this._doneCb = jQuery.Callbacks();
        this.done = $.proxy(this._doneCb, "add");
        // Fires when bug field is changed via set/add/remove
        // Callback params (bug_object, field_name, new_field_value)
        this._changedCb = jQuery.Callbacks();
        this.changed = $.proxy(this._changedCb, "add");
        // Fires when choices for field change, i.e when the field it depends
        // on changes
        // Callback params (bug_object, changed_field, dependent_field, new_choices)
        this._choicesCb = jQuery.Callbacks();
        this.choicesUpdated = $.proxy(this._choicesCb, "add");
    },
    isModified: function()
    {
        return !$.isEmptyObject(this._modified);
    },

    /**
     * Save changes or new bug
     */
    save: function()
    {
        if (!this.isModified()) return;
        if (this._data.id) {
            var rpc = new Rpc("Bug", "update",
                    this._getUpdateParams());
        } else {
            var rpc = new Rpc("Bug", "create", this._modified);
        }
        rpc.done($.proxy(this, "_saveDone"));
        rpc.fail($.proxy(this, "_saveFail"));
    },

    _getUpdateParams: function()
    {
        var params = {ids: [this._data.id]};
        for (var name in this._modified) {
            var fd = Bug.fd(name);
            if (name == 'comment') {
                params[name] = {body: this._modified[name]};
                // TODO private comment support?
            } else if (fd.multivalue) {
                var add = [];
                var remove = this._data[name];
                this._modified[name].forEach(function(value) {
                    var index = remove.indexOf(value);
                    if(index == -1) {
                        add.push(value);
                    } else {
                        remove.splice(index, 1);
                    }
                });
                params[name] = {add: add, remove: remove};
            } else {
                params[name] = this._modified[name];
            }
        }
        return params;
    },
    _saveDone: function(result)
    {
        if (result.id) {
            // Newly created bug, update
            this._data.id = result.id;
            this.update()
        } else {
            // Existing bug updated
            var changes = result.bugs[0].changes;
            for (var name in changes) {
                var change = changes[name];
                if ($.isArray(this._data[name])){
                    var added = change.added.split(/\s*,\s*/);
                    var removed = change.removed.split(/\s*,\s*/);
                    for (var i=0; i < added.length; i++) {
                        this._data[name].push(added[i]);
                    }
                    for (var i=0; i < removed.length; i++) {
                        var index = this._data[name].indexOf(removed[i]);
                        if (index != -1) this._data[name].pop(index);
                    }
                } else if (change.added) {
                    this._data[name] = change.added;
                } else if (change.removed) {
                    this._data[name] = null;
                }
                this._changedCb.fire(this, name, this._data[name]);
            }
            this._modified = {};
            this._doneCb.fire(this);
        }
    },
    _saveFail: function(error)
    {
        alert("Saving bug failed: " + error.message);
    },

    /**
     * Update bug data from database
     */
    update: function() {
        if (!this._data.id) throw "Can't update unsaved bug";
        var rpc = new Rpc("Bug", "get", {ids:[this._data.id]});
        rpc.done($.proxy(this, "_getDone"));
        rpc.fail($.proxy(this, "_getFail"));
    },

    _getDone:function(result) {
        for (var name in result.bugs[0]) {
            this.set(name, result.bugs[0][name]);
        }
        for (var name in this._modified) {
            this._data[name] = this._modified[name];
            delete this._modified[name];
        }
        this._doneCb.fire(this);
    },

    _getFail:function(error) {
        alert("Loading bug failed: " + error.message);
    },

    value: function(name)
    {
        return this._modified[name] || this._data[name];
    },
    choices: function(name)
    {
        var fdesc = Bug.fd(name);
        var choices = [];
        var visibleFor = fdesc.value_field ? this.value(fdesc.value_field) : null;
        fdesc.values.forEach(function(value) {
            if (visibleFor && value.visibility_values.indexOf(visibleFor) == -1)
                return;
            choices.push(value);
        });
        choices.sort(function(a,b) {
            var result = a.sort_key - b.sork_key;
            if(result == 0) {
                if (a.name < b.name) result = -1;
                if (a.name > b.name) result = 1;
            }
            return result;
        });
        return choices.map(function(value) {return value.name})
    },

    /**
     * Set bug field values
     *
     * set({ field_name: value, ...}) - to set multiple values
     *   or
     * set(field_name, value) - to set single value
     */
    set: function(name, value) {
        if(arguments.length == 1) {
            for (var key in name) {
                this.set(key, name[key]);
            }
            return;
        }
        var fdesc = Bug.fd(name);
        if (fdesc.immutable)
            return;
        if (fdesc.multivalue && !$.isArray(value))
            value = [value];

        if (this._data[name] != value){
            this._modified[name] = value;
            this._changedCb.fire(this, name, value);
            this._checkDependencies(fdesc, value);
        } else {
            delete this._modified[name];
        }
    },
    add: function(name, value) {
        var fdesc = Bug.fd(name);
        if (!fdesc.multivalue) {
            this.set(name, value);
            return;
        }
        if (!$.isArray(this._data[name])) this._data[name] = [];
        if (this.value(name).indexOf(value) == -1) {
            this._modified[name] = this._data[name].slice();
            this._modified[name].push(value);
            this._changedCb.fire(this, name, this._modified[name]);
            this._checkDependencies(fdesc, value);
        }
    },
    remove: function(name, value) {
        var fdesc = Bug.fd(name);
        if (!fdesc.multivalue) {
            this.set(name, value);
            return;
        }
        if (!$.isArray(this._data[name])) this._data[name] = [];
        var index = this.value(name).indexOf(value);
        if (index != -1) {
            this._modified[name] = this._data[name].slice();
            this._modified[name].splice(index, 1);
            this._changedCb.fire(this, name, this._data[name]);
            this._checkDependencies(fdesc, value);
        }
    },
    _checkDependencies: function(fdesc, value)
    {
        if (!fdesc.depends) return;
        for (var i=0; i < fdesc.depends.length; i++) {
            var dname = fdesc.depends[i];
            var choices = this.choices(dname);
            if(choices.indexOf(this.value(dname)) == -1) {
                this.set(dname, choices[0]);
            }
            this._choicesCb.fire(this, name, dname, choices);
        }
    },

}, {
    get: function(ids, callback)
    {
        var multiple = true;
        if (!$.isArray(ids)) {
            ids = [ids];
            multiple = false;
        }
        var rpc = new Rpc("Bug", "get", {ids: ids});
        rpc.done(function(result) {
            var bugs = [];
            for(var i=0; i < result.bugs.length; i++) {
                bugs.push(new Bug(result.bugs[i]));
            }
            if (!multiple) {
                bugs = bugs[0];
            }
            callback(bugs);
        });
        rpc.fail(function(error) {
            callback([], error.message);
        });
    },

    /**
     * Map for field names which do not match between Bug.create() params and
     * Bug.fields() return value
     */
    FieldType: {
        UNKNOWN: 0,
        STRING: 1,
        SELECT: 2,
        MULTI: 3,
        TEXT: 4,
        DATE: 5,
        BUGID: 6,
        URL: 7,
        USER: 11,
        BOOLEAN: 12,
    },

    _fetch: $.Deferred(),
    _rpc: null,
    _fields: null,

    fd: function(name)
    {
        if (!Bug._fields == null) throw "Bug field data not fetched";
        var fdesc = Bug._fields[name];
        if (fdesc == undefined) throw "Unknown field '"+name+"'";
        return fdesc;
    },

    /**
     * Get field descriptors for fields required in Bug.create() RPC.
     */
    requiredFields: function() {
        if (!Bug._fields == null) throw "Bug field data not fetched";
        var required = [];
        for (var name in Bug._fields) {
            if (Bug._fields[name].is_mandatory) {
                required.push(Bug._fields[name]);
            }
        }
        return required;
    },

    initFields: function() {
        if (Bug._rpc == null) {
            Bug._rpc = new Rpc("BayotBase", "fields");
            Bug._rpc.done(Bug._processFields);
            Bug._rpc.fail(function(error) {
                Bug._rpc = null;
                Bug._fetch = $.Deferred();
                alert("Failed to get bug fields: " + error.message);
            });
        }
        return Bug._fetch.promise();
    },

    initOnCall: function(fn, fnThis)
    {
        return function() {
            var args = [].slice.apply(arguments);
            if (Bug._fetch.isResolved())
                return fn.apply(fnThis, args)
            Bug.initFields().done(function() {
                fn.apply(fnThis, args);
            });
        };
    },

    /**
     * Handle BayotBase.fields() RPC result
     * Stores the field data in
     */
    _processFields: function(result) {
        var fields = {};
        var depends = {};
        for (var i = 0; i < result.fields.length; i++) {
            var fdesc = result.fields[i];
            fields[fdesc.name] = fdesc;
            if (fdesc.value_field) {
                if (depends[fdesc.value_field] == undefined)
                    depends[fdesc.value_field] = [];
                depends[fdesc.value_field].push(fdesc.name);
            }
        }
        for (var name in depends) {
            fields[name].depends = depends[name];
        }
        Bug._fields = fields;
        Bug._fetch.resolve();
    },
});

/**
 * User input field autocomplete widget
 */
$.widget("bb.userautocomplete", {
    /**
     * Initialize the widget
     */
    _create: function()
    {
        // Initialize autocomplete on the element
        this.element.autocomplete({
            minLength: 3,
            delay: 500,
            source: $.proxy(this, "_source"),
            focus: $.proxy(this, "_onItemFocus"),
            select: $.proxy(this, "_onItemSelect"),
        })
        .data("autocomplete")._renderItem = function(ul, item) {
            // Custom rendering for the suggestion list items
            return $("<li></li>").data("item.autocomplete", item)
                .append("<a>" + item.real_name + "</a>")
                .appendTo(ul);
        };
        // Add spinner
        this.spinner = $("<div/>").addClass("bb-spinner")
            .css("position", "absolute")
            .hide();
        this.element.after(this.spinner)

        this._respCallback = null;
    },

    /**
     * Destroy the widget
     */
    destroy: function()
    {
        this.element.autocomplete("destroy");
        this.spinner.remove();
        $.Widge.prototype.destroy.apply(this);
    },

    /**
     * jQuery UI autocomplete item focus handler
     */
    _onItemFocus: function(event, ui) {
        this.element.val(ui.item.name);
        return false;
    },

    /**
     * jQuery UI autocomplete item select handler
     */
    _onItemSelect: function(event, ui) {
        this.element.val(ui.item.name);
        return false;
    },

    /**
     * jQuery UI autocomplete data source function
     */
    _source: function(request, responce) {
        this._respCallback = responce;
        var terms = this._splitTerms(request.term.toLowerCase());

        var rpc = new Rpc("User", "get", {match:terms});
        rpc.done($.proxy(this, "_userGetDone"));
        rpc.complete($.proxy(this.spinner, "hide"));

        this.spinner.css("top", this.element.position().top)
            .css("left", this.element.position().left + this.element.width())
            .show();
    },

    /**
     * Helper to split user input into separate terms
     */
    _splitTerms: function(term) {
        var result = [];
        var tmp = term.split(' ');
        for (var i=0; i < tmp.length; i++) {
            if (tmp[i].length > 0) result.push(tmp[i]);
        }
        return result;
    },

    /**
     * Handler for User.get() rpc
     */
    _userGetDone: function(result) {
        if (this._respCallback) {
            this._respCallback(result.users);
        }
        this._respCallback = null;
    },
});


/**
 * Bug entry widget
 */
$.widget("bb.bugentry", {
    /**
     * Default options
     *
     * fields: Fields to display in the form
     * title: Title of the dialog
     * defaults: Default values to populate the form with
     */
    options: {
        fields: ['summary', 'product', 'component', 'severity', 'priority', 'comment'],
        title: 'Create bug',
        defaults: {},
    },

    /**
     * Initialize the widget
     */
    _create: function()
    {
        this._openDialog = Bug.initOnCall(this._openDialog, this);
        // Set click handler
        this.element.on("click", $.proxy(this, "_openDialog"));
        this._form = null;
    },

    /**
     * Destroy the widget
     */
    destroy: function()
    {
        this.element.off("click", $.proxy(this, "_openDialog"));
        this._destroyDialog();
    },

    /**
     * Opens the bug entry dialog when element is clicked.
     */
    _openDialog: function() {
        delete this._bug;
        this._bug = new Bug(this.options.defaults);
        this._bug.done($.proxy(this, "_createDone"));
        if (this._form == null) {
            this._createForm();
            this._form.dialog({
                width: 800,
                title: this.options.title,
                position: ['center', 'top'],
                autoOpen: false,
                modal: true,
                buttons: {
                    "Save": $.proxy(this, '_saveBug'),
                    "Cancel": function (){$(this).dialog("close");},
                },
                close: $.proxy(this, '_destroyDialog'),
            });
        }
        this._form.dialog("open");
    },

    /**
     * Creates the bug entry form
     */
    _createForm: function() {
        if (this._form) return;
        this._form = $('<form></form>');
        var table = $('<table></table>');
        this._form.append(table);

        // Create fields
        for (var i = 0; i < this.options.fields.length; i++) {
            var fdesc = Bug.fd(this.options.fields[i]);
            var row = $('<tr></tr>');
            row.append(
                $('<th></th>').append(
                    $('<label></label>')
                        .attr("for", fdesc.name)
                        .text(fdesc.display_name)
                )
            );
            var input = this._createInput(fdesc);
            row.append($('<td></td>').append(input));
            table.append(row);
        }
        // Add required but not shown fields
        var required = Bug.requiredFields();
        for (var i=0; i < required.length; i++) {
            var fdesc = required[i];
            if(this.options.fields.indexOf(fdesc.name) != -1) continue;
            var input = this._createInput(fdesc, true);
            this._form.append(input);
        }
        this._bug.choicesUpdated($.proxy(this, "_updateChoices"));
    },

    /**
     * Creates input element for given field
     */
    _createInput: function(field, hidden) {
        var element;
        if(hidden) {
            var element = $('<input type="hidden"></input>');
        } else if (field.type == Bug.FieldType.SELECT ||
                field.type == Bug.FieldType.MULTI) {
            var element = $("<select></select>");
            if (field.multivalue) {
                element.attr('multiple', 'multiple');
            }
            this._setSelectOptions(element, field.name,
                    this._bug.choices(field.name));
            element.change($.proxy(this, "_selectChanged"));
        } else if (field.type == Bug.FieldType.TEXT) {
            var element = $("<textarea></textarea>")
                .attr('rows', 10)
                .attr('cols', 80);
        } else {
            var element = $("<input></input>");
        }
        if (field.type == Bug.FieldType.USER) {
            element.userautocomplete();
        }
        var value = this._bug.value(field.name) || this._bug.choices(field.name)[0];
        element.attr("name", field.name).val(value);
        return element;
    },

    /**
     * Populate select box with options
     */
    _setSelectOptions: function(element, name, choices)
    {
        element.empty();
        var current = this._bug.value(name);
        choices.forEach(function(value) {
            var option = $('<option>' + value + '</option>')
                .attr('value', value);
            if (value == current)
                option.attr('selected', 'selected');
            element.append(option);
        });
    },

    /**
     * Select box change handler
     */
    _selectChanged: function(ev)
    {
        var target = $(ev.target);
        var name = target.attr('name');
        var value = target.val();
        console.log("change", name, value);
        this._bug.set(name, value);
    },

    /**
     * Update values when field choices change
     */
    _updateChoices: function(bug, changed, field, choices) {
        var element = this._form.find("[name=" + field + "]");
        if (!element.size()) return;
        if (element.attr('type') == 'hidden') {
            element.val(bug.value(field));
        } else {
            this._setSelectOptions(element, field, choices);
        }
    },

    /**
     * Destroys the dialog
     */
    _destroyDialog: function() {
        if (this._form == null) return;
        this._form.dialog("destroy");
        this._form.remove();
        this._form = null;
    },

    /**
     * Bug entry dialog save button handler
     */
    _saveBug: function() {
        var params = {};
        fields = this._form.serializeArray();
        for (var i=0; i < fields.length; i++) {
            var field = fields[i];
            params[field.name] = field.value;
        }
        this._bug.set(params);
        this._bug.save();
    },
    /**
     * Bug.save() done-callback handler
     */
    _createDone: function(bug) {
        this._destroyDialog();
        this._trigger("success", null, { bug: bug, bug_id: bug.value('id') });
    },
});
