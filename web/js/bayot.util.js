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